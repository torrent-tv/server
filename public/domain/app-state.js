/**
 * @file The application state machine: states, the transition relation, and the
 * outputs derived from a state. Pure — no DOM, no events, no side effects — so
 * the whole thing is testable with `node --test` and so the component that
 * drives it cannot quietly grow rules of its own.
 *
 * Four principles decide everything here; they are the project rule, not taste.
 *
 * 1. **Moore, not Mealy.** An output depends on the state alone, never on the
 *    edge taken to reach it. So which view is on screen, whether the waiting
 *    overlay shows, and what the media element is told are FUNCTIONS OF THE
 *    STATE, computed by each view from {@link viewForState} and friends. The old
 *    design hung them on the edges — entering PLAYING dispatched "show the
 *    player" — and four flows (quality switch, audio switch, reconnect, Retry)
 *    then showed the loading view with no transition at all: the state said
 *    PLAYING while the screen said loading, and nothing could detect it, because
 *    the state asserted nothing about the screen. Under Moore that is not
 *    expressible.
 * 2. **Extended state machine.** Something becomes a state only when it changes
 *    what is legal or what is shown. Everything else stays a variable with a
 *    guard — see {@link StateContext}. Otherwise N independent flags would need
 *    2^N states.
 * 3. **Hierarchy (Harel statecharts).** An edge shared by several states is
 *    declared once on their superstate; {@link nextState} walks up the
 *    containment chain to find it. `CLOSED` and `FATAL_FAILURE` are written once
 *    on OPEN instead of three times each.
 * 4. **The transition relation is a graph.** Deterministic (one target per state
 *    and event), total (every pair answered — an unlisted pair is IGNORED, never
 *    an exception), every state reachable, no dead ends. And the edges that are
 *    ABSENT carry the meaning: see {@link ABSENT_EDGE_INVARIANTS}.
 */

/**
 * Control states.
 *
 * `STALLED` is the answer to the question that shaped this machine — is a seek
 * "processing"? It is: a seek, a scrub while paused, and starvation mid-playback
 * are one state, because they produce identical outputs and identical legal
 * behaviour. What differs between them — the numbers on the overlay, and the
 * repositioning of the encoder — is data and a transition action, neither of
 * which is a reason to split a state.
 *
 * @readonly
 */
export const APP_STATE = Object.freeze({
  /** No source is open. */
  IDLE: "IDLE",
  /**
   * A source is open, no file is being built, and the viewer is choosing which
   * one to play.
   *
   * Named for the situation, not for the thing on screen. A state called
   * PLAYLIST would name a widget, and the machine exists so that the view
   * follows the state rather than the other way round — when the choice is
   * offered as a gallery of frames instead of a list, the widget changes and
   * this does not.
   */
  CHOOSING_FILE: "CHOOSING_FILE",
  /** A source is open; no playable stream exists yet. */
  OPENING: "OPENING",
  /** The picture is moving. */
  ADVANCING: "ADVANCING",
  /** A frame is wanted right now and is not available. */
  STALLED: "STALLED",
  /**
   * The viewer asked for a change to the stream and the picture is held until
   * that change is ready. Today the one change that raises it is a soundtrack
   * published as its own rendition: the player discards the audio it holds the
   * moment it is told to move, so a switch made before the track exists leaves
   * the picture with nothing to play.
   *
   * It is a state and not a variable because it changes both outputs a state is
   * allowed to change: the waiting overlay is on screen, and the play control
   * refuses input. Letting the picture run through the wait means the viewer
   * watches on in a language they did not choose and then has to go back over
   * it — which is the report this state was written for, 2026-09-03.
   */
  SWITCHING: "SWITCHING",
  /** The viewer stopped playback; no frame is wanted. */
  PAUSED: "PAUSED",
  /** A failure the pipeline declared unrecoverable. */
  ERROR: "ERROR"
});

/** Where the machine starts. Exported so no driver has to hardcode it. */
export const INITIAL_STATE = APP_STATE.IDLE;

/**
 * The views the app can show. An enum rather than bare strings so a typo is a
 * missing export instead of a silently wrong screen.
 *
 * @readonly
 */
export const APP_VIEW = Object.freeze({
  PICKER: "picker",
  PLAYER: "player",
  ERROR: "error"
});

/**
 * What a state implies for the media element. See {@link mediaIntentForState}.
 *
 * @readonly
 */
export const MEDIA_INTENT = Object.freeze({
  PLAY: "play",
  PAUSE: "pause",
  /** Neither — the element's own behaviour is right and must not be overridden. */
  LEAVE: "leave"
});

/**
 * Superstates. Not states themselves — containers, used for two things: to
 * declare a shared edge once, and to express an output over a group.
 *
 * @readonly
 */
export const APP_SUPERSTATE = Object.freeze({
  /** A stream exists: ADVANCING, STALLED, SWITCHING, PAUSED. */
  LIVE: "LIVE",
  /** A source is open: OPENING plus everything in LIVE. */
  OPEN: "OPEN"
});

/**
 * Freeze an object and everything under it. `Object.freeze` is shallow, so a
 * frozen table of tables leaves the inner rows writable — and a transition
 * relation that can be edited at runtime is not a specification.
 *
 * @template T
 * @param {T} value
 * @returns {T}
 */
function deepFreeze(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const inner of Object.values(value)) {
      deepFreeze(inner);
    }
  }
  return value;
}

/**
 * Containment: which superstate each state sits in, innermost first. This is the
 * chain {@link nextState} walks when a state has no edge of its own for an event.
 *
 * @type {Readonly<Record<string, string | null>>}
 */
const PARENT = Object.freeze({
  [APP_STATE.IDLE]: null,
  [APP_STATE.ERROR]: null,
  [APP_STATE.CHOOSING_FILE]: APP_SUPERSTATE.OPEN,
  [APP_STATE.OPENING]: APP_SUPERSTATE.OPEN,
  [APP_STATE.ADVANCING]: APP_SUPERSTATE.LIVE,
  [APP_STATE.STALLED]: APP_SUPERSTATE.LIVE,
  [APP_STATE.SWITCHING]: APP_SUPERSTATE.LIVE,
  [APP_STATE.PAUSED]: APP_SUPERSTATE.LIVE,
  [APP_SUPERSTATE.LIVE]: APP_SUPERSTATE.OPEN,
  [APP_SUPERSTATE.OPEN]: null
});

/**
 * Events the machine accepts. Named for what HAPPENED, never for the state they
 * lead to: an event that names its target ("go to playing") cannot be refused
 * without contradicting itself, which is how the old `BACK_TO_PLAYLIST` came to
 * demand a state it had no right to.
 *
 * @readonly
 */
export const APP_EVENT = Object.freeze({
  /** A torrent or magnet was opened, or a file within one was chosen. */
  SOURCE_OPENED: "SOURCE_OPENED",
  /** Enough media is ready for the picture to start. */
  STREAM_READY: "STREAM_READY",
  /** A frame is wanted now and is not available (seek, scrub, starvation). */
  FRAME_BLOCKED: "FRAME_BLOCKED",
  /** The wanted frame arrived. */
  FRAME_AVAILABLE: "FRAME_AVAILABLE",
  /** The viewer stopped playback. Mirrors the media element, never decides it. */
  PAUSED_BY_VIEWER: "PAUSED_BY_VIEWER",
  /** The viewer started playback again. */
  RESUMED: "RESUMED",
  /**
   * The viewer asked for a change the stream must be made ready for before the
   * picture may move — today, a soundtrack published as its own rendition.
   * Raised again for a second pick made while the first is still being
   * prepared; that is the self-transition on LIVE.
   */
  SWITCH_REQUESTED: "SWITCH_REQUESTED",
  /**
   * The change is over, however it ended: applied, refused, or abandoned
   * because the viewer picked something else. One event for all three, because
   * they end the hold in exactly the same way and the state has no business
   * knowing which of them happened.
   */
  SWITCH_FINISHED: "SWITCH_FINISHED",
  /** The stream must be built again: quality or audio switch, reconnect, Retry. */
  REBUILD_REQUIRED: "REBUILD_REQUIRED",
  /** A failure the pipeline says cannot be recovered from. */
  FATAL_FAILURE: "FATAL_FAILURE",
  /** The viewer closed the source and went back to the picker. */
  CLOSED: "CLOSED",
  /**
   * The viewer asked to choose a different file of the source that is already
   * open — "Back to episodes" on the error screen.
   */
  FILE_CHOICE_REQUESTED: "FILE_CHOICE_REQUESTED"
});

/**
 * Extended state — the variables transitions are allowed to consult. Everything
 * here was deliberately NOT made a state.
 *
 * `viewerWantsPlayback` mirrors the media element (`!video.paused`); the element owns
 * the fact and the machine only projects it, so there is one source of truth and
 * not two. It decides where a stream that has just become ready goes: a viewer
 * who paused during a rebuild must not have their pause overridden by the
 * rebuild finishing.
 *
 * The field is `viewerWantsPlayback` and the output below is `shouldBePlaying`;
 * they are deliberately not the same word, because they are not the same fact.
 * One is what the viewer asked for, the other is what the state implies. One
 * concept, one name — and two concepts, two names.
 *
 * Omitting the field reads as "wants playback", which is right for every path
 * except a rebuild finishing under a pause. That one path is exactly where a
 * caller must pass it, and it is documented at both guards.
 *
 * @typedef {object} StateContext
 * @property {boolean} [viewerWantsPlayback] - Whether the viewer wants the
 *   picture to move — `!video.paused`. Defaults to true.
 */

/**
 * The transition relation. One target per state and event — determinism is
 * asserted by the shape of this object, not by convention.
 *
 * A value may be a function of {@link StateContext} where a guard is needed. The
 * guards here are total: every branch names a state, so no context can leave a
 * transition undefined.
 *
 * @type {Readonly<Record<string, Record<string, string | ((context: StateContext) => string)>>>}
 */
const TRANSITIONS = deepFreeze({
  [APP_STATE.IDLE]: {
    [APP_EVENT.SOURCE_OPENED]: APP_STATE.OPENING
  },

  [APP_STATE.CHOOSING_FILE]: {
    // Choosing one starts building it.
    [APP_EVENT.SOURCE_OPENED]: APP_STATE.OPENING
  },

  [APP_STATE.OPENING]: {
    // A rebuild that finishes while the viewer is paused must land in PAUSED,
    // not start playing at them.
    [APP_EVENT.STREAM_READY]: (context) =>
      context.viewerWantsPlayback === false ? APP_STATE.PAUSED : APP_STATE.ADVANCING
  },

  [APP_STATE.ADVANCING]: {
    [APP_EVENT.FRAME_BLOCKED]: APP_STATE.STALLED,
    [APP_EVENT.PAUSED_BY_VIEWER]: APP_STATE.PAUSED
  },

  [APP_STATE.STALLED]: {
    [APP_EVENT.FRAME_AVAILABLE]: (context) =>
      context.viewerWantsPlayback === false ? APP_STATE.PAUSED : APP_STATE.ADVANCING,
    [APP_EVENT.PAUSED_BY_VIEWER]: APP_STATE.PAUSED
  },

  [APP_STATE.SWITCHING]: {
    // Where the hold ends is decided by what the viewer wanted BEFORE it began.
    // The pause that holds the picture is one of ours and is marked as such, so
    // `viewerWantsPlayback` still carries their last real decision — which is
    // the whole reason the hold is a state here rather than a pause of the
    // element: read from `!video.paused`, this answer would always be "no".
    [APP_EVENT.SWITCH_FINISHED]: (context) =>
      context.viewerWantsPlayback === false ? APP_STATE.PAUSED : APP_STATE.ADVANCING
  },

  [APP_STATE.PAUSED]: {
    [APP_EVENT.RESUMED]: APP_STATE.ADVANCING,
    // Scrubbing while paused DOES want a frame — the target one — so it is a
    // stall like any other. This is why the predicate is "a frame is wanted and
    // unavailable" rather than "playback is running and starved", and why the
    // shipped fix that drives the spinner from `video.seeking` instead of
    // `readyState` is correct rather than merely observed to work.
    [APP_EVENT.FRAME_BLOCKED]: APP_STATE.STALLED
  },

  // Declared once for everything in LIVE, SWITCHING included. A picture that is
  // moving, one that is stalled and one the viewer stopped all answer a pick the
  // same way — the picture is held and the overlay comes up — and a SECOND pick
  // made during a hold is the self-transition that falls out of the same row:
  // the state does not change, so no output moves, while the pipeline abandons
  // the earlier pick and waits for the new one.
  //
  // It sits on LIVE and not on OPEN deliberately. A pick needs a stream to
  // change, and OPENING has none: sent there it would hold a picture that is not
  // yet running and then release it into a state the build had already left.
  [APP_SUPERSTATE.LIVE]: {
    [APP_EVENT.SWITCH_REQUESTED]: APP_STATE.SWITCHING
  },

  // Declared once for OPENING and everything in LIVE. `FATAL_FAILURE` and
  // `CLOSED` are written three times each in the machine this replaces.
  //
  // `REBUILD_REQUIRED` sits here rather than on LIVE, and the difference is not
  // cosmetic: OPENING's parent is OPEN, not LIVE, so on LIVE it would not reach
  // a rebuild asked for while the stream is still being built. Two real cases
  // live in that window — changing quality during a cold open, and the transport
  // dying mid-load, which is the failure server 0.8.84 was written for. From
  // OPENING it is an EXTERNAL SELF-TRANSITION: the state does not change, so no
  // output changes, while the build itself starts again. Whether the rebuild
  // action re-runs is decided by the event, not by the state changing.
  [APP_SUPERSTATE.OPEN]: {
    [APP_EVENT.REBUILD_REQUIRED]: APP_STATE.OPENING,
    [APP_EVENT.FATAL_FAILURE]: APP_STATE.ERROR,
    [APP_EVENT.CLOSED]: APP_STATE.IDLE
  },

  [APP_STATE.ERROR]: {
    // Retrying, or picking another episode from the error screen, OPENS a
    // source. It does not resume one: there is nothing to resume.
    [APP_EVENT.SOURCE_OPENED]: APP_STATE.OPENING,
    // "Back to episodes" opens no file: it returns to the choice. Sending this
    // to OPENING instead left the machine claiming a build that nobody had
    // started, and the modal waiting view came up over the episode list with
    // the failed file's name still on it.
    [APP_EVENT.FILE_CHOICE_REQUESTED]: APP_STATE.CHOOSING_FILE,
    [APP_EVENT.CLOSED]: APP_STATE.IDLE
  }
});

/**
 * What the MISSING edges assert — as data, so the tests execute them instead of
 * reading prose. An invariant written only in a comment is one nobody checks,
 * and this list is the machine's actual content: the edges present in a
 * near-complete digraph say nothing, the absent ones say everything.
 *
 * Each entry: from this state, this event must never produce this target.
 *
 * @type {ReadonlyArray<{ from: string, event: string, mustNotReach: string, because: string }>}
 */
export const ABSENT_EDGE_INVARIANTS = Object.freeze([
  {
    from: APP_STATE.IDLE,
    event: APP_EVENT.STREAM_READY,
    mustNotReach: APP_STATE.ADVANCING,
    because: "nothing plays that was not opened first"
  },
  {
    from: APP_STATE.IDLE,
    event: APP_EVENT.FATAL_FAILURE,
    mustNotReach: APP_STATE.ERROR,
    because: "a failure needs an open source — this is the edge a late event from an abandoned attempt used to take"
  },
  {
    from: APP_STATE.IDLE,
    event: APP_EVENT.FRAME_BLOCKED,
    mustNotReach: APP_STATE.STALLED,
    because: "a stall presupposes a stream"
  },
  {
    from: APP_STATE.ERROR,
    event: APP_EVENT.SOURCE_OPENED,
    mustNotReach: APP_STATE.ADVANCING,
    because: "a file cannot start advancing without being opened"
  },
  {
    from: APP_STATE.SWITCHING,
    event: APP_EVENT.RESUMED,
    mustNotReach: APP_STATE.ADVANCING,
    because:
      "nothing the element says lifts a hold the viewer asked for — only the change finishing does. " +
      "A play that slips past the disabled control must not become the machine's decision, which is " +
      "how the viewer used to end up watching on in the language they had just replaced"
  },
  {
    from: APP_STATE.SWITCHING,
    event: APP_EVENT.PAUSED_BY_VIEWER,
    mustNotReach: APP_STATE.PAUSED,
    because:
      "the hold already stops the picture; leaving it for PAUSED would take the overlay off screen and " +
      "hand the play control back while the track is still being made"
  },
  {
    from: APP_STATE.SWITCHING,
    event: APP_EVENT.FRAME_BLOCKED,
    mustNotReach: APP_STATE.STALLED,
    because: "a wait the viewer asked for is not starvation, and the two must not be counted as one"
  }
]);

/**
 * The state `event` leads to, or `null` when the event means nothing here.
 *
 * Two different facts, deliberately given two different answers:
 *
 *   - `null` — no edge exists for this pair. The event is IGNORED. This is a
 *     real, expected answer, and a driver may reasonably log it as a surprise.
 *   - the state that was passed in — an edge exists and it leads back here.
 *     Nothing changed; the driver must not re-run entry work. Returning `null`
 *     for this too, as the first version did, threw away the distinction
 *     between "meaningless" and "no-op", which are the two things a driver most
 *     needs to tell apart when something looks wrong.
 *
 * Never throws. The machine this replaces did, from inside a DOM event
 * listener, so a refused transition abandoned the rest of the handler and left
 * flags describing a state the app was no longer in — its safety check was
 * itself the failure mode.
 *
 * @param {string} state - Current state.
 * @param {string} event - One of {@link APP_EVENT}.
 * @param {StateContext} [context] - Extended state consulted by guards.
 * @returns {string | null} The next state (possibly `state` itself), or null.
 */
export function nextState(state, event, context = {}) {
  // Walk the containment chain: the state itself, then its superstates. An edge
  // on a superstate applies to every state inside it, and a state's own edge
  // wins over an inherited one.
  let scope = state;
  while (scope) {
    const target = TRANSITIONS[scope]?.[event];
    if (target !== undefined) {
      return typeof target === "function" ? target(context) : target;
    }
    scope = PARENT[scope] ?? null;
  }
  return null;
}

/**
 * Whether `state` sits inside `superstate` (or is it).
 *
 * @param {string} state
 * @param {string} superstate - One of {@link APP_SUPERSTATE}.
 * @returns {boolean}
 */
export function isWithin(state, superstate) {
  let scope = state;
  while (scope) {
    if (scope === superstate) {
      return true;
    }
    scope = PARENT[scope] ?? null;
  }
  return false;
}

/**
 * Which view belongs on screen. A structural output: a pure function of the
 * state and of nothing else.
 *
 * @param {string} state
 * @returns {string} One of {@link APP_VIEW}.
 */
export function viewForState(state) {
  if (state === APP_STATE.ERROR) {
    return APP_VIEW.ERROR;
  }
  return isWithin(state, APP_SUPERSTATE.OPEN) ? APP_VIEW.PLAYER : APP_VIEW.PICKER;
}

/**
 * Whether the waiting overlay belongs on screen — the viewer is waiting for data
 * and the picture cannot move.
 *
 * Note this group is NOT a superstate: OPENING sits outside LIVE while STALLED
 * sits inside it, so the two do not nest and cannot be a container. It is a
 * predicate over states, which is what an output is.
 *
 * @param {string} state
 * @returns {boolean}
 */
export function isWaiting(state) {
  return state === APP_STATE.OPENING || state === APP_STATE.STALLED || state === APP_STATE.SWITCHING;
}

/**
 * Whether the play control accepts input. False while the picture is held for a
 * change the viewer asked for, and true everywhere else.
 *
 * A separate output, and not something read off {@link mediaIntentForState}:
 * PAUSED says "pause" too, and there the control must work. The two states
 * differ in exactly this, which is what makes the hold a state at all.
 *
 * @param {string} state
 * @returns {boolean}
 */
export function acceptsPlaybackInput(state) {
  return state !== APP_STATE.SWITCHING;
}

/**
 * What the media element should be told, if anything.
 *
 * Three values rather than a boolean, and the third is the reason: there are
 * states where the right action is to touch nothing. A boolean
 * "should it be playing" forced an answer for STALLED, and both answers are
 * wrong — a stall during playback must not be paused, and a scrub while paused
 * must not be started. STALLED covers both, which is correct for the overlay and
 * useless as a play/pause command, so it commands neither.
 *
 * @param {string} state
 * @returns {string} One of {@link MEDIA_INTENT}.
 */
export function mediaIntentForState(state) {
  if (state === APP_STATE.ADVANCING) {
    return MEDIA_INTENT.PLAY;
  }
  if (state === APP_STATE.OPENING || state === APP_STATE.STALLED) {
    return MEDIA_INTENT.LEAVE;
  }
  if (state === APP_STATE.SWITCHING) {
    // Stated here rather than left to fall through to the same answer below. The
    // hold is the one wait that DOES command the element: holding the picture is
    // what the state is for, and the pause is issued as ours so the viewer's own
    // intent survives the wait and decides where it ends.
    return MEDIA_INTENT.PAUSE;
  }
  // PAUSED, IDLE, ERROR. The last two keep the standing invariant that nothing
  // plays while the player is not on screen: a hidden <video> still emits audio.
  return MEDIA_INTENT.PAUSE;
}

/**
 * Every declared edge, flattened, for tests and for drawing the graph.
 * Superstate edges are reported against the superstate, not expanded.
 *
 * @returns {Array<{ from: string, event: string, to: string | "guarded" }>}
 */
export function declaredEdges() {
  const edges = [];
  for (const [from, byEvent] of Object.entries(TRANSITIONS)) {
    for (const [event, target] of Object.entries(byEvent)) {
      edges.push({ from, event, to: typeof target === "function" ? "guarded" : target });
    }
  }
  return edges;
}
