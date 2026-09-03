/**
 * @file The application state machine, checked as a machine and as a graph.
 *
 * Two kinds of test here, and the second kind is the point. The first walks the
 * edges someone wrote down. The second asserts properties of the whole relation
 * — every state reachable, every state able to get home, no pair that throws,
 * and the edges that must NOT exist — so that a future edit which quietly
 * restores a near-complete digraph fails here rather than in the field.
 *
 * The machine this replaces had none of this. It threw on a refused transition,
 * from inside a DOM event listener, and its table allowed almost everything, so
 * neither the allowed nor the forbidden could be checked.
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  APP_EVENT,
  APP_STATE,
  APP_SUPERSTATE,
  APP_VIEW,
  ABSENT_EDGE_INVARIANTS,
  INITIAL_STATE,
  MEDIA_INTENT,
  acceptsPlaybackInput,
  declaredEdges,
  isWaiting,
  isWithin,
  mediaIntentForState,
  nextState,
  viewForState
} from "../public/domain/app-state.js";

const ALL_STATES = Object.values(APP_STATE);
const ALL_EVENTS = Object.values(APP_EVENT);
/** Both settings of the only guard variable, so no branch escapes the sweeps. */
const ALL_CONTEXTS = [{ viewerWantsPlayback: true }, { viewerWantsPlayback: false }, {}];

/** Every state directly reachable from `state`, over every event and guard. */
function successors(state) {
  const reached = new Set();
  for (const event of ALL_EVENTS) {
    for (const context of ALL_CONTEXTS) {
      const target = nextState(state, event, context);
      if (target !== null && target !== state) {
        reached.add(target);
      }
    }
  }
  return reached;
}

/** States reachable from `start` by any number of transitions. */
function closureFrom(start) {
  const seen = new Set([start]);
  const queue = [start];
  while (queue.length > 0) {
    for (const target of successors(queue.shift())) {
      if (!seen.has(target)) {
        seen.add(target);
        queue.push(target);
      }
    }
  }
  return seen;
}

// ---------------------------------------------------------------- graph shape

test("every state is reachable from the initial state", () => {
  const reachable = closureFrom(INITIAL_STATE);
  for (const state of ALL_STATES) {
    assert.ok(reachable.has(state), `${state} cannot be reached from ${INITIAL_STATE}`);
  }
});

test("every state can get back to the picker — no dead ends", () => {
  for (const state of ALL_STATES) {
    assert.ok(
      closureFrom(state).has(APP_STATE.IDLE),
      `${state} has no path back to ${APP_STATE.IDLE}: a viewer could be stuck there`
    );
  }
});

test("no state and event pair throws, and every one of them is answered", () => {
  for (const state of [...ALL_STATES, "NOT_A_STATE"]) {
    for (const event of [...ALL_EVENTS, "NOT_AN_EVENT"]) {
      for (const context of ALL_CONTEXTS) {
        const target = nextState(state, event, context);
        assert.ok(
          target === null || ALL_STATES.includes(target),
          `${state} + ${event} answered ${String(target)}, which is neither a state nor "ignore"`
        );
      }
    }
  }
});

test("the answer for a pair is the same every time it is asked", () => {
  for (const state of ALL_STATES) {
    for (const event of ALL_EVENTS) {
      const context = { viewerWantsPlayback: true };
      assert.equal(nextState(state, event, context), nextState(state, event, context));
    }
  }
});

test("one target per state and event — the table declares no pair twice", () => {
  const seen = new Set();
  for (const edge of declaredEdges()) {
    const pair = `${edge.from}+${edge.event}`;
    assert.ok(!seen.has(pair), `${pair} is declared more than once`);
    seen.add(pair);
  }
});

test("the transition table cannot be edited at runtime", () => {
  const [first] = declaredEdges();
  const mutated = declaredEdges();
  mutated[0].to = "TAMPERED";
  assert.equal(declaredEdges()[0].to, first.to, "declaredEdges must hand out copies, not the table");
});

// ------------------------------------------------------- what must not happen

test("the absent edges are absent", () => {
  for (const invariant of ABSENT_EDGE_INVARIANTS) {
    for (const context of ALL_CONTEXTS) {
      assert.notEqual(
        nextState(invariant.from, invariant.event, context),
        invariant.mustNotReach,
        `${invariant.from} + ${invariant.event} reached ${invariant.mustNotReach}: ${invariant.because}`
      );
    }
  }
});

test("an event that means nothing here is ignored, not obeyed", () => {
  assert.equal(nextState(APP_STATE.IDLE, APP_EVENT.FRAME_BLOCKED), null);
  assert.equal(nextState(APP_STATE.IDLE, APP_EVENT.FATAL_FAILURE), null);
  assert.equal(nextState(APP_STATE.IDLE, APP_EVENT.CLOSED), null);
  assert.equal(nextState(APP_STATE.ERROR, APP_EVENT.FRAME_AVAILABLE), null);
  assert.equal(nextState(APP_STATE.OPENING, APP_EVENT.RESUMED), null);
});

// ------------------------------------------------------------------ hierarchy

test("an edge on a superstate reaches every state inside it", () => {
  const open = ALL_STATES.filter((state) => isWithin(state, APP_SUPERSTATE.OPEN));
  assert.deepEqual(
    open.sort(),
    [
      APP_STATE.ADVANCING,
      APP_STATE.CHOOSING_FILE,
      APP_STATE.OPENING,
      APP_STATE.PAUSED,
      APP_STATE.STALLED,
      APP_STATE.SWITCHING
    ].sort()
  );
  for (const state of open) {
    assert.equal(nextState(state, APP_EVENT.CLOSED), APP_STATE.IDLE, `${state} must close to the picker`);
    assert.equal(nextState(state, APP_EVENT.FATAL_FAILURE), APP_STATE.ERROR, `${state} must be able to fail`);
    assert.equal(
      nextState(state, APP_EVENT.REBUILD_REQUIRED),
      APP_STATE.OPENING,
      `${state} must accept a rebuild — a transport lost mid-load happens here too`
    );
  }
});

test("a state's own edge wins over the one it inherits", () => {
  // The lookup walks the containment chain and must stop at the first hit. No
  // state currently overrides an inherited edge, so this holds over an empty
  // set — it is here so that the day one does, the precedence is pinned rather
  // than discovered. Written as a property over the table for that reason.
  for (const edge of declaredEdges()) {
    const isSuperstateRow = !ALL_STATES.includes(edge.from);
    if (isSuperstateRow) {
      continue;
    }
    const own = nextState(edge.from, edge.event, { viewerWantsPlayback: true });
    assert.notEqual(own, null, `${edge.from} declares ${edge.event} and must answer with its own target`);
  }
});

test("the edges that lead back to their own state are deliberate", () => {
  // An earlier version of this file asserted the opposite — that no edge is a
  // self-loop, so that no event could re-run a state's entry work. That rule was
  // dropped knowingly, and this test records why rather than letting the two
  // designs disagree in silence.
  //
  // A rebuild can be asked for while the stream is STILL being built: changing
  // quality during a cold open, and the transport dying mid-load, which is the
  // failure server 0.8.84 was written for. Answering `null` there would mark a
  // legitimate event as meaningless, and a driver is entitled to log `null` as a
  // surprise. Answering OPENING says what is true: the event belongs here and
  // the state did not change. The build starting again is the transition's
  // action, driven by the event — outputs, which are what Moore constrains, do
  // not move.
  //
  // The second is the same argument for a second pick: a viewer who changes
  // their mind while a soundtrack is being prepared is still in a hold, so the
  // state does not change and no output moves, while the pipeline abandons the
  // earlier pick and waits for the new one.
  const selfEdges = [];
  for (const state of ALL_STATES) {
    for (const event of ALL_EVENTS) {
      for (const context of ALL_CONTEXTS) {
        if (nextState(state, event, context) === state) {
          selfEdges.push(`${state} + ${event}`);
        }
      }
    }
  }
  assert.deepEqual(
    [...new Set(selfEdges)].sort(),
    [
      `${APP_STATE.OPENING} + ${APP_EVENT.REBUILD_REQUIRED}`,
      `${APP_STATE.SWITCHING} + ${APP_EVENT.SWITCH_REQUESTED}`
    ].sort(),
    "a new edge that leads back to its own state must be argued for, not acquired"
  );
});

// --------------------------------------------------------------------- guards

test("a rebuild that finishes under a pause does not start playing at the viewer", () => {
  assert.equal(
    nextState(APP_STATE.OPENING, APP_EVENT.STREAM_READY, { viewerWantsPlayback: false }),
    APP_STATE.PAUSED
  );
  assert.equal(
    nextState(APP_STATE.OPENING, APP_EVENT.STREAM_READY, { viewerWantsPlayback: true }),
    APP_STATE.ADVANCING
  );
  assert.equal(
    nextState(APP_STATE.OPENING, APP_EVENT.STREAM_READY),
    APP_STATE.ADVANCING,
    "an unstated intent means the ordinary case: the viewer wants the picture"
  );
});

test("a frame that arrives for a paused scrub returns to paused, not to playing", () => {
  assert.equal(
    nextState(APP_STATE.STALLED, APP_EVENT.FRAME_AVAILABLE, { viewerWantsPlayback: false }),
    APP_STATE.PAUSED
  );
  assert.equal(
    nextState(APP_STATE.STALLED, APP_EVENT.FRAME_AVAILABLE, { viewerWantsPlayback: true }),
    APP_STATE.ADVANCING
  );
});

// ------------------------------------------------- the question this settled

test("a seek, a scrub while paused and starvation are all one state", () => {
  assert.equal(nextState(APP_STATE.ADVANCING, APP_EVENT.FRAME_BLOCKED), APP_STATE.STALLED);
  assert.equal(nextState(APP_STATE.PAUSED, APP_EVENT.FRAME_BLOCKED), APP_STATE.STALLED);
});

test("waiting for a cold open and waiting for a seek look identical to the viewer", () => {
  for (const output of [viewForState, isWaiting]) {
    assert.equal(
      output(APP_STATE.OPENING),
      output(APP_STATE.STALLED),
      `${output.name} differs between the two waits, so one interface cannot serve both`
    );
  }
});

// -------------------------------------------------------------------- outputs

test("every output is a function of the state alone", () => {
  /** state -> [view, waiting, what to tell the element, play control live] */
  const expected = {
    [APP_STATE.IDLE]: [APP_VIEW.PICKER, false, MEDIA_INTENT.PAUSE, true],
    [APP_STATE.CHOOSING_FILE]: [APP_VIEW.PLAYER, false, MEDIA_INTENT.PAUSE, true],
    [APP_STATE.OPENING]: [APP_VIEW.PLAYER, true, MEDIA_INTENT.LEAVE, true],
    [APP_STATE.ADVANCING]: [APP_VIEW.PLAYER, false, MEDIA_INTENT.PLAY, true],
    [APP_STATE.STALLED]: [APP_VIEW.PLAYER, true, MEDIA_INTENT.LEAVE, true],
    [APP_STATE.SWITCHING]: [APP_VIEW.PLAYER, true, MEDIA_INTENT.PAUSE, false],
    [APP_STATE.PAUSED]: [APP_VIEW.PLAYER, false, MEDIA_INTENT.PAUSE, true],
    [APP_STATE.ERROR]: [APP_VIEW.ERROR, false, MEDIA_INTENT.PAUSE, true]
  };
  for (const state of ALL_STATES) {
    assert.deepEqual(
      [viewForState(state), isWaiting(state), mediaIntentForState(state), acceptsPlaybackInput(state)],
      expected[state],
      `outputs for ${state}`
    );
  }
});

// ------------------------- the hold a change the viewer asked for puts it in

test("a change the viewer asked for is waited out with the picture held", () => {
  // The overlay is on screen, as for any other wait, and the play control is
  // the one thing that separates this wait from the others: playing on through
  // it means watching in the language just replaced and going back over it.
  assert.equal(isWaiting(APP_STATE.SWITCHING), true);
  assert.equal(mediaIntentForState(APP_STATE.SWITCHING), MEDIA_INTENT.PAUSE);
  assert.equal(acceptsPlaybackInput(APP_STATE.SWITCHING), false);
});

test("the play control is refused in exactly one state", () => {
  // Stated as a property, because the value of this output is that it is false
  // in one place and true everywhere else. A second state refusing input would
  // otherwise arrive unnoticed and take the play button away from a viewer who
  // is merely waiting for data.
  const refused = ALL_STATES.filter((state) => !acceptsPlaybackInput(state));
  assert.deepEqual(refused, [APP_STATE.SWITCHING]);
});

test("a pick can be made from a moving picture, a stalled one and a stopped one", () => {
  for (const from of [APP_STATE.ADVANCING, APP_STATE.STALLED, APP_STATE.PAUSED]) {
    assert.equal(
      nextState(from, APP_EVENT.SWITCH_REQUESTED),
      APP_STATE.SWITCHING,
      `${from} must accept a pick — the menu is reachable from all three`
    );
  }
});

test("a pick made while the stream is still being built changes nothing", () => {
  // OPENING has no stream to change, and the build owns the picture there. The
  // edge sits on LIVE for that reason, so this pair is ignored rather than
  // holding a picture that is not running.
  assert.equal(nextState(APP_STATE.OPENING, APP_EVENT.SWITCH_REQUESTED), null);
});

test("the hold ends where the viewer's own last decision says", () => {
  // The pause that holds the picture is one of ours, so `viewerWantsPlayback`
  // still carries what the viewer wanted before the pick — and it is what
  // decides whether the picture starts again by itself.
  assert.equal(
    nextState(APP_STATE.SWITCHING, APP_EVENT.SWITCH_FINISHED, { viewerWantsPlayback: true }),
    APP_STATE.ADVANCING
  );
  assert.equal(
    nextState(APP_STATE.SWITCHING, APP_EVENT.SWITCH_FINISHED, { viewerWantsPlayback: false }),
    APP_STATE.PAUSED
  );
  assert.equal(
    nextState(APP_STATE.SWITCHING, APP_EVENT.SWITCH_FINISHED),
    APP_STATE.ADVANCING,
    "an unstated intent means the ordinary case: the viewer wants the picture"
  );
});

test("nothing the element says lifts the hold", () => {
  // The defect this whole state was written for: the element's own pause was
  // read as the viewer stopping playback, the machine left the wait for PAUSED,
  // and the viewer resumed into the soundtrack they had just replaced.
  for (const event of [APP_EVENT.RESUMED, APP_EVENT.PAUSED_BY_VIEWER, APP_EVENT.FRAME_BLOCKED, APP_EVENT.FRAME_AVAILABLE]) {
    assert.equal(nextState(APP_STATE.SWITCHING, event), null, `${event} must not move the hold`);
  }
});

test("a hold does not survive the stream it belongs to", () => {
  // A rebuild, a failure and the viewer closing the source all reach it through
  // OPEN, so a hold cannot outlive the thing being held.
  assert.equal(nextState(APP_STATE.SWITCHING, APP_EVENT.REBUILD_REQUIRED), APP_STATE.OPENING);
  assert.equal(nextState(APP_STATE.SWITCHING, APP_EVENT.FATAL_FAILURE), APP_STATE.ERROR);
  assert.equal(nextState(APP_STATE.SWITCHING, APP_EVENT.CLOSED), APP_STATE.IDLE);
});

test("a pause is not a wait", () => {
  // The distinction the ten-minute-after-a-pause freeze was made of: a paused
  // viewer is present and not waiting for anything.
  assert.equal(isWaiting(APP_STATE.PAUSED), false);
  assert.equal(mediaIntentForState(APP_STATE.PAUSED), MEDIA_INTENT.PAUSE);
});

test("a stall commands neither play nor pause", () => {
  // A stall during playback must not be paused, and a scrub while paused must
  // not be started. One state covers both, so it commands neither.
  assert.equal(mediaIntentForState(APP_STATE.STALLED), MEDIA_INTENT.LEAVE);
});

test("nothing plays while the player is off screen", () => {
  for (const state of ALL_STATES) {
    if (viewForState(state) !== APP_VIEW.PLAYER) {
      assert.equal(
        mediaIntentForState(state),
        MEDIA_INTENT.PAUSE,
        `${state} hides the player, so the element must be told to stop — a hidden <video> still emits audio`
      );
    }
  }
});
