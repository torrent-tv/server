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
 *    overlay shows, and whether the controls accept input are FUNCTIONS OF THE
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
export const APP_STATE = {
  /** No source is open. */
  IDLE: "IDLE",
  /** A source is open; no playable stream exists yet. */
  OPENING: "OPENING",
  /** The picture is moving. */
  ADVANCING: "ADVANCING",
  /** A frame is wanted right now and is not available. */
  STALLED: "STALLED",
  /** The viewer stopped playback; no frame is wanted. */
  PAUSED: "PAUSED",
  /** A failure the pipeline declared unrecoverable. */
  ERROR: "ERROR"
};

/**
 * Superstates. Not states themselves — containers, used for two things: to
 * declare a shared edge once, and to express an output over a group.
 *
 * @readonly
 */
export const APP_SUPERSTATE = {
  /** A stream exists: ADVANCING, STALLED, PAUSED. */
  LIVE: "LIVE",
  /** A source is open: OPENING plus everything in LIVE. */
  OPEN: "OPEN"
};

/**
 * Containment: which superstate each state sits in, innermost first. This is the
 * chain {@link nextState} walks when a state has no edge of its own for an event.
 *
 * @type {Readonly<Record<string, string | null>>}
 */
const PARENT = Object.freeze({
  [APP_STATE.IDLE]: null,
  [APP_STATE.ERROR]: null,
  [APP_STATE.OPENING]: APP_SUPERSTATE.OPEN,
  [APP_STATE.ADVANCING]: APP_SUPERSTATE.LIVE,
  [APP_STATE.STALLED]: APP_SUPERSTATE.LIVE,
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
export const APP_EVENT = {
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
  /** The stream must be built again: quality or audio switch, reconnect, Retry. */
  REBUILD_REQUIRED: "REBUILD_REQUIRED",
  /** A failure the pipeline says cannot be recovered from. */
  FATAL_FAILURE: "FATAL_FAILURE",
  /** The viewer closed the source and went back to the picker. */
  CLOSED: "CLOSED"
};

/**
 * Extended state — the variables transitions are allowed to consult. Everything
 * here was deliberately NOT made a state.
 *
 * `wantsPlayback` mirrors the media element (`!video.paused`); the element owns
 * the fact and the machine only projects it, so there is one source of truth and
 * not two. It decides where a stream that has just become ready goes: a viewer
 * who paused during a rebuild must not have their pause overridden by the
 * rebuild finishing.
 *
 * @typedef {object} StateContext
 * @property {boolean} [wantsPlayback] - Whether the viewer wants the picture to
 *   move. Defaults to true: everything except a deliberate pause wants it.
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
const TRANSITIONS = Object.freeze({
  [APP_STATE.IDLE]: {
    [APP_EVENT.SOURCE_OPENED]: APP_STATE.OPENING
  },

  [APP_STATE.OPENING]: {
    // A rebuild that finishes while the viewer is paused must land in PAUSED,
    // not start playing at them.
    [APP_EVENT.STREAM_READY]: (context) =>
      context.wantsPlayback === false ? APP_STATE.PAUSED : APP_STATE.ADVANCING
  },

  [APP_STATE.ADVANCING]: {
    [APP_EVENT.FRAME_BLOCKED]: APP_STATE.STALLED,
    [APP_EVENT.PAUSED_BY_VIEWER]: APP_STATE.PAUSED
  },

  [APP_STATE.STALLED]: {
    [APP_EVENT.FRAME_AVAILABLE]: (context) =>
      context.wantsPlayback === false ? APP_STATE.PAUSED : APP_STATE.ADVANCING,
    [APP_EVENT.PAUSED_BY_VIEWER]: APP_STATE.PAUSED
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

  // Declared once for ADVANCING, STALLED and PAUSED.
  [APP_SUPERSTATE.LIVE]: {
    [APP_EVENT.REBUILD_REQUIRED]: APP_STATE.OPENING
  },

  // Declared once for OPENING and everything in LIVE. Written three times each
  // in the machine this replaces.
  [APP_SUPERSTATE.OPEN]: {
    [APP_EVENT.FATAL_FAILURE]: APP_STATE.ERROR,
    [APP_EVENT.CLOSED]: APP_STATE.IDLE
  },

  [APP_STATE.ERROR]: {
    // Retrying, or picking another episode from the error screen, OPENS a
    // source. It does not resume one: there is nothing to resume.
    [APP_EVENT.SOURCE_OPENED]: APP_STATE.OPENING,
    [APP_EVENT.CLOSED]: APP_STATE.IDLE
  }
});

/**
 * What the missing edges assert. Kept as text beside the table because an
 * invariant nobody wrote down is one nobody checks; the tests below read this
 * list back.
 *
 * @readonly
 */
export const ABSENT_EDGE_INVARIANTS = Object.freeze([
  "nothing plays that was not opened first: no IDLE to ADVANCING",
  "a failure needs an open source: no IDLE to ERROR",
  "a stall presupposes a stream: no IDLE to STALLED",
  "a file cannot advance without being opened: no ERROR to ADVANCING"
]);

/**
 * The state after `event`, or `null` when the machine ignores it.
 *
 * Ignoring is a real answer and the only one for an unlisted pair. The machine
 * this replaces threw instead, from inside a DOM event listener, so a wrong
 * transition abandoned the rest of the handler and left flags set for a state
 * the app was no longer in — the safety check was itself the failure mode.
 *
 * @param {string} state - Current state.
 * @param {string} event - One of {@link APP_EVENT}.
 * @param {StateContext} [context] - Extended state consulted by guards.
 * @returns {string | null} The next state, or null to ignore the event.
 */
export function nextState(state, event, context = {}) {
  // Walk the containment chain: the state itself, then its superstates. An edge
  // on a superstate applies to every state inside it, and a state's own edge
  // wins over an inherited one.
  let scope = state;
  while (scope) {
    const target = TRANSITIONS[scope]?.[event];
    if (target !== undefined) {
      const resolved = typeof target === "function" ? target(context) : target;
      // A transition to the state already occupied is not a transition. Callers
      // must not re-run entry work for it.
      return resolved === state ? null : resolved;
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
 * @returns {"picker" | "player" | "error"}
 */
export function viewForState(state) {
  if (state === APP_STATE.ERROR) {
    return "error";
  }
  return isWithin(state, APP_SUPERSTATE.OPEN) ? "player" : "picker";
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
  return state === APP_STATE.OPENING || state === APP_STATE.STALLED;
}

/**
 * Whether the player's controls should accept input. Nothing is worth
 * controlling before a stream exists — a seek bar over a file that has not been
 * opened can only mislead.
 *
 * @param {string} state
 * @returns {boolean}
 */
export function controlsLive(state) {
  return isWithin(state, APP_SUPERSTATE.LIVE);
}

/**
 * Whether the picture is meant to be moving. False while paused, and false
 * before a stream exists; true while stalled, because a stall is a frame that is
 * wanted and missing, not a decision to stop.
 *
 * @param {string} state
 * @returns {boolean}
 */
export function playbackWanted(state) {
  return state === APP_STATE.ADVANCING || state === APP_STATE.STALLED;
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
