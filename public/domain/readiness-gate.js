/**
 * @file The one reading of the proxy's playback forecast (`playbackReadiness`)
 * that decides whether the picture may move, at start and after a seek
 * (torrent-tv/meta#289). The contract says a missing forecast, or one of a
 * version the page does not know, does not authorise playback; the proxy sends
 * `null` for a superseded action.
 */

/**
 * What one answer of the proxy's forecast means for the picture.
 *
 * Rules, in order; the first that matches decides:
 * 1. asked for before the seek was reported (`reportedAt` given and not
 *    reached by `requestedAt`) → `stale`: the answer is not read at all;
 * 2. no forecast → `wait`;
 * 3. a forecast version other than 1 → `wait`;
 * 4. a timestamp gap in the prepared media → `fail`;
 * 5. not ready → `wait` with the proxy's reason;
 * 6. the start subtitle is still being read → `wait`;
 * 7. otherwise `release` with the proxy's reason.
 *
 * @param {{ readiness?: object | null, requestedAt?: number, reportedAt?: number,
 *   subtitleHold?: string | null }} [answer] - `requestedAt` and `reportedAt`
 *   are on one clock; the start omits `reportedAt` (no seek to compare with).
 *   `subtitleHold` is the value of `subtitleStartHold(...)`.
 * @returns {{ verdict: "release" | "wait" | "stale" | "fail", reason: string }}
 */
export function readinessVerdict({ readiness, requestedAt, reportedAt, subtitleHold } = {}) {
  if (typeof reportedAt === "number" && !(requestedAt >= reportedAt)) {
    return { verdict: "stale", reason: "asked-before-seek-reported" };
  }
  if (readiness === null || typeof readiness !== "object") {
    return { verdict: "wait", reason: "forecast-missing" };
  }
  if (readiness.version !== 1) return { verdict: "wait", reason: "forecast-version-unsupported" };
  if (readiness.reason === "media-continuity-unavailable") {
    return { verdict: "fail", reason: "media-continuity-unavailable" };
  }
  if (readiness.ready !== true) {
    return { verdict: "wait", reason: String(readiness.reason ?? "forecast-unavailable") };
  }
  if (subtitleHold === "subtitles-pending") return { verdict: "wait", reason: "subtitles-pending" };
  return { verdict: "release", reason: String(readiness.reason ?? "ready") };
}
