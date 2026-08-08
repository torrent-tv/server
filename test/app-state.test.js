/**
 * @file The application state machine, as a graph and as a set of outputs.
 *
 * Every flow bug this project has had landed in the machine — a wrong screen
 * after an episode switch, a transport lost mid-load, a state that said PLAYING
 * while the loading view was up. None of them were catchable, because the rules
 * lived inside DOM event handlers where nothing could read them back. They are a
 * table and four pure functions now, so this file can assert the properties the
 * design is meant to have rather than the behaviour of one path through it.
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  APP_STATE,
  APP_EVENT,
  APP_SUPERSTATE,
  ABSENT_EDGE_INVARIANTS,
  nextState,
  isWithin,
  viewForState,
  isWaiting,
  controlsLive,
  playbackWanted,
  declaredEdges
} from "../public/domain/app-state.js";

const ALL_STATES = Object.values(APP_STATE);
const ALL_EVENTS = Object.values(APP_EVENT);
const PLAYING_CONTEXT = { wantsPlayback: true };
const PAUSED_CONTEXT = { wantsPlayback: false };

/** Both context values, since a guard may send one event to two states. */
const CONTEXTS = [PLAYING_CONTEXT, PAUSED_CONTEXT];

test("opening a source is the only way out of IDLE", () => {
  assert.equal(nextState(APP_STATE.IDLE, APP_EVENT.SOURCE_OPENED), APP_STATE.OPENING);
  for (const event of ALL_EVENTS) {
    if (event === APP_EVENT.SOURCE_OPENED) {
      continue;
    }
    for (const context of CONTEXTS) {
      assert.equal(
        nextState(APP_STATE.IDLE, event, context),
        null,
        `${event} must be ignored in IDLE, not answered`
      );
    }
  }
});

test("a stream that becomes ready respects a viewer who paused during the rebuild", () => {
  assert.equal(
    nextState(APP_STATE.OPENING, APP_EVENT.STREAM_READY, PLAYING_CONTEXT),
    APP_STATE.ADVANCING
  );
  assert.equal(
    nextState(APP_STATE.OPENING, APP_EVENT.STREAM_READY, PAUSED_CONTEXT),
    APP_STATE.PAUSED,
    "a rebuild finishing must not start playback at someone who pressed pause"
  );
});

test("a seek, a scrub while paused and starvation are all one state", () => {
  // Playing and starved.
  assert.equal(nextState(APP_STATE.ADVANCING, APP_EVENT.FRAME_BLOCKED), APP_STATE.STALLED);
  // Scrubbing while paused: a frame IS wanted — the target one.
  assert.equal(nextState(APP_STATE.PAUSED, APP_EVENT.FRAME_BLOCKED), APP_STATE.STALLED);
  // And back, to whichever of the two the viewer actually wants.
  assert.equal(
    nextState(APP_STATE.STALLED, APP_EVENT.FRAME_AVAILABLE, PLAYING_CONTEXT),
    APP_STATE.ADVANCING
  );
  assert.equal(
    nextState(APP_STATE.STALLED, APP_EVENT.FRAME_AVAILABLE, PAUSED_CONTEXT),
    APP_STATE.PAUSED,
    "a scrub that lands while paused must leave the viewer paused on the new frame"
  );
});

test("pause is a state of its own, because an output differs", () => {
  assert.equal(nextState(APP_STATE.ADVANCING, APP_EVENT.PAUSED_BY_VIEWER), APP_STATE.PAUSED);
  assert.equal(nextState(APP_STATE.STALLED, APP_EVENT.PAUSED_BY_VIEWER), APP_STATE.PAUSED);
  assert.equal(nextState(APP_STATE.PAUSED, APP_EVENT.RESUMED), APP_STATE.ADVANCING);
  // The output that forced the split: nothing else about PAUSED differs from
  // ADVANCING, and this does.
  assert.equal(playbackWanted(APP_STATE.ADVANCING), true);
  assert.equal(playbackWanted(APP_STATE.PAUSED), false);
  assert.equal(playbackWanted(APP_STATE.STALLED), true, "a stall is not a decision to stop");
});

test("closing and failing are declared once, on the superstate, and reach every state inside it", () => {
  for (const state of [APP_STATE.OPENING, APP_STATE.ADVANCING, APP_STATE.STALLED, APP_STATE.PAUSED]) {
    assert.equal(nextState(state, APP_EVENT.CLOSED), APP_STATE.IDLE, `CLOSED from ${state}`);
    assert.equal(nextState(state, APP_EVENT.FATAL_FAILURE), APP_STATE.ERROR, `FATAL_FAILURE from ${state}`);
  }
  // Inherited from LIVE, and NOT available in OPENING — a stream that does not
  // exist cannot be rebuilt, it is simply still being built.
  for (const state of [APP_STATE.ADVANCING, APP_STATE.STALLED, APP_STATE.PAUSED]) {
    assert.equal(nextState(state, APP_EVENT.REBUILD_REQUIRED), APP_STATE.OPENING);
  }
  assert.equal(nextState(APP_STATE.OPENING, APP_EVENT.REBUILD_REQUIRED), null);
});

test("a state's own edge wins over the one it inherits", () => {
  // ERROR declares CLOSED itself; it is outside OPEN, so it cannot inherit.
  assert.equal(nextState(APP_STATE.ERROR, APP_EVENT.CLOSED), APP_STATE.IDLE);
  assert.equal(nextState(APP_STATE.ERROR, APP_EVENT.SOURCE_OPENED), APP_STATE.OPENING);
});

test("an unlisted pair is ignored, never thrown and never guessed", () => {
  for (const state of ALL_STATES) {
    for (const event of ALL_EVENTS) {
      for (const context of CONTEXTS) {
        const target = nextState(state, event, context);
        assert.ok(
          target === null || ALL_STATES.includes(target),
          `${state} + ${event} answered ${String(target)}, which is not a state`
        );
      }
    }
  }
});

test("a transition to the state already occupied is not a transition", () => {
  // Entering PROCESSING twice used to re-run entry work. Re-entry is reported as
  // "nothing happened" so a caller cannot repeat it by accident.
  assert.equal(nextState(APP_STATE.ADVANCING, APP_EVENT.RESUMED), null);
  assert.equal(nextState(APP_STATE.PAUSED, APP_EVENT.PAUSED_BY_VIEWER), null);
  assert.equal(nextState(APP_STATE.IDLE, APP_EVENT.CLOSED), null);
});

test("the transition relation is deterministic", () => {
  for (const state of ALL_STATES) {
    for (const event of ALL_EVENTS) {
      for (const context of CONTEXTS) {
        assert.equal(
          nextState(state, event, context),
          nextState(state, event, context),
          `${state} + ${event} is not a function of its inputs`
        );
      }
    }
  }
});

test("every state is reachable from IDLE", () => {
  const seen = new Set([APP_STATE.IDLE]);
  const queue = [APP_STATE.IDLE];
  while (queue.length > 0) {
    const state = queue.shift();
    for (const event of ALL_EVENTS) {
      for (const context of CONTEXTS) {
        const target = nextState(state, event, context);
        if (target !== null && !seen.has(target)) {
          seen.add(target);
          queue.push(target);
        }
      }
    }
  }
  for (const state of ALL_STATES) {
    assert.ok(seen.has(state), `${state} is unreachable, so it is not part of the machine`);
  }
});

test("no state is a dead end — IDLE is reachable from all of them", () => {
  for (const start of ALL_STATES) {
    const seen = new Set([start]);
    const queue = [start];
    let reachesIdle = start === APP_STATE.IDLE;
    while (queue.length > 0 && !reachesIdle) {
      const state = queue.shift();
      for (const event of ALL_EVENTS) {
        for (const context of CONTEXTS) {
          const target = nextState(state, event, context);
          if (target === APP_STATE.IDLE) {
            reachesIdle = true;
          }
          if (target !== null && !seen.has(target)) {
            seen.add(target);
            queue.push(target);
          }
        }
      }
    }
    assert.ok(reachesIdle, `${start} cannot get back to the picker`);
  }
});

test("the absent edges assert what they are supposed to assert", () => {
  assert.equal(nextState(APP_STATE.IDLE, APP_EVENT.STREAM_READY), null,
    "nothing plays that was not opened first");
  assert.equal(nextState(APP_STATE.IDLE, APP_EVENT.FATAL_FAILURE), null,
    "a failure needs an open source — this is the edge a late event from an abandoned attempt used to take");
  assert.equal(nextState(APP_STATE.IDLE, APP_EVENT.FRAME_BLOCKED), null,
    "a stall presupposes a stream");
  assert.notEqual(nextState(APP_STATE.ERROR, APP_EVENT.SOURCE_OPENED), APP_STATE.ADVANCING,
    "a file cannot start advancing without being opened");
  assert.equal(ABSENT_EDGE_INVARIANTS.length, 4, "the written invariants and the asserted ones must not drift");
});

test("the view is a function of the state and of nothing else", () => {
  assert.equal(viewForState(APP_STATE.IDLE), "picker");
  assert.equal(viewForState(APP_STATE.ERROR), "error");
  for (const state of [APP_STATE.OPENING, APP_STATE.ADVANCING, APP_STATE.STALLED, APP_STATE.PAUSED]) {
    assert.equal(viewForState(state), "player", `${state} shows the player`);
  }
});

test("the overlay shows exactly while a wanted frame is missing", () => {
  assert.equal(isWaiting(APP_STATE.OPENING), true);
  assert.equal(isWaiting(APP_STATE.STALLED), true);
  assert.equal(isWaiting(APP_STATE.ADVANCING), false);
  assert.equal(isWaiting(APP_STATE.PAUSED), false, "a pause is not a wait — this is the ten-minute freeze");
  assert.equal(isWaiting(APP_STATE.IDLE), false);
  assert.equal(isWaiting(APP_STATE.ERROR), false);
});

test("controls accept input only once there is something to control", () => {
  assert.equal(controlsLive(APP_STATE.OPENING), false, "a seek bar over an unopened file can only mislead");
  assert.equal(controlsLive(APP_STATE.ADVANCING), true);
  assert.equal(controlsLive(APP_STATE.STALLED), true);
  assert.equal(controlsLive(APP_STATE.PAUSED), true);
  assert.equal(controlsLive(APP_STATE.IDLE), false);
});

test("containment is what makes a shared edge declarable once", () => {
  assert.equal(isWithin(APP_STATE.STALLED, APP_SUPERSTATE.LIVE), true);
  assert.equal(isWithin(APP_STATE.STALLED, APP_SUPERSTATE.OPEN), true);
  assert.equal(isWithin(APP_STATE.OPENING, APP_SUPERSTATE.OPEN), true);
  assert.equal(isWithin(APP_STATE.OPENING, APP_SUPERSTATE.LIVE), false,
    "OPENING is open but not live — that difference is the whole reason both exist");
  assert.equal(isWithin(APP_STATE.IDLE, APP_SUPERSTATE.OPEN), false);
  assert.equal(isWithin(APP_STATE.ERROR, APP_SUPERSTATE.OPEN), false);
});

test("the graph stays small enough to hold in one's head", () => {
  const edges = declaredEdges();
  assert.ok(edges.length <= 14, `the table has grown to ${edges.length} edges; a near-complete digraph asserts nothing`);
  for (const edge of edges) {
    assert.ok(
      edge.to === "guarded" || ALL_STATES.includes(edge.to),
      `${edge.from} + ${edge.event} points at ${edge.to}, which is not a state`
    );
  }
});
