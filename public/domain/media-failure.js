/**
 * @file What a failure of the media element is, and the next step against it.
 *
 * A media element that fails stops for good: the HTML specification gives it
 * an `error` and no way back other than loading a new source. hls.js notices
 * only on its next append — measured 2026-10-04, 4.7 s later — and its own
 * reset reads the position after the source has closed, which is zero, so the
 * film started again from the beginning.
 *
 * Recovery is therefore decided here, from what the failure IS, and in the
 * order of what each step costs. Two things are kept apart on purpose:
 *
 * 1. the description of the failure — the element's own code and message,
 *    which is the only statement of the cause there is;
 * 2. the step taken against it, which is a function of that description and
 *    of what has already been tried at the same place.
 *
 * The ladder today is generic: rebuild the element's source at the position
 * where it failed, which costs the media already buffered ahead and nothing
 * else; and if the element fails again at the same place after that, restart
 * the stream, which the viewer is offered with the reason. A step written for
 * one kind of failure — a fragment the proxy should make again, a level the
 * decoder cannot take — belongs in {@link elementRecoveryStep}, keyed by the
 * failure's kind, and is not built yet.
 */

/**
 * `MediaError.code`, named. The numbers are the HTML specification's.
 *
 * @readonly
 */
export const MEDIA_FAILURE_KIND = Object.freeze({
  /** 1 — fetching was aborted at the user agent's request. */
  ABORTED: "aborted",
  /** 2 — a network error stopped fetching. */
  NETWORK: "network",
  /** 3 — the media could not be decoded. */
  DECODE: "decode",
  /** 4 — the source or a format in it is not supported. */
  UNSUPPORTED: "unsupported",
  /** A code the specification does not define. */
  UNKNOWN: "unknown",
  /** The element holds no error. */
  NONE: "none"
});

const KIND_BY_CODE = Object.freeze({
  1: MEDIA_FAILURE_KIND.ABORTED,
  2: MEDIA_FAILURE_KIND.NETWORK,
  3: MEDIA_FAILURE_KIND.DECODE,
  4: MEDIA_FAILURE_KIND.UNSUPPORTED
});

/**
 * @typedef {object} MediaFailure
 * @property {number | null} code - `MediaError.code`, or null without an error.
 * @property {string} kind - One of {@link MEDIA_FAILURE_KIND}.
 * @property {string} message - The browser's own message; empty when it gave
 *   none. Chromium names the failing stage in it, so it is kept whole.
 */

/**
 * Describe the element's error as it stands.
 *
 * @param {{ code?: unknown, message?: unknown } | null | undefined} error -
 *   `HTMLMediaElement.error`.
 * @returns {MediaFailure}
 */
export function describeMediaFailure(error) {
  if (!error || typeof error !== "object") {
    return { code: null, kind: MEDIA_FAILURE_KIND.NONE, message: "" };
  }
  const code = Number.isInteger(error.code) ? Number(error.code) : null;
  return {
    code,
    kind: (code !== null && KIND_BY_CODE[code]) || MEDIA_FAILURE_KIND.UNKNOWN,
    message: typeof error.message === "string" ? error.message : ""
  };
}

/**
 * The steps against a failed element, cheapest first.
 *
 * @readonly
 */
export const ELEMENT_RECOVERY_STEP = Object.freeze({
  /**
   * The manifest is not in yet, so the start-up flow is running and owns every
   * failure until it finishes.
   */
  LEAVE_TO_START_UP: "leave-to-start-up",
  /**
   * Give the element a new source and put loading and the playhead back where
   * it failed. Costs the media buffered ahead of that point.
   */
  REBUILD_AT_POSITION: "rebuild-at-position",
  /**
   * Open the stream again. Offered to the viewer with the reason, through the
   * same path as any other player that cannot continue.
   */
  RESTART_STREAM: "restart-stream"
});

/**
 * The next step against a failed element.
 *
 * `rebuildsHere` counts the rebuilds already made at the place this failure
 * happened at. A rebuild there that was followed by the same failure is a
 * step measured not to help at that place, which is why the next one is a
 * different step. It is not a statement about the cause: the failure's kind
 * is what a step for a particular cause is to be chosen by.
 *
 * @param {{ failure: MediaFailure, rebuildsHere: number, manifestReady: boolean }} facts
 * @returns {string} One of {@link ELEMENT_RECOVERY_STEP}.
 */
export function elementRecoveryStep(facts) {
  // `facts.failure` is not consulted yet: every kind takes the generic ladder
  // below until a step written for that kind exists.
  if (!facts.manifestReady) {
    return ELEMENT_RECOVERY_STEP.LEAVE_TO_START_UP;
  }
  if (!(facts.rebuildsHere > 0)) {
    return ELEMENT_RECOVERY_STEP.REBUILD_AT_POSITION;
  }
  return ELEMENT_RECOVERY_STEP.RESTART_STREAM;
}
