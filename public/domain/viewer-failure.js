/**
 * @file What the viewer is told when playback fails, and what goes to the log.
 *
 * WHY THIS EXISTS. Every failure path of the loading flow used to show
 * `error.message` on the error screen, whatever produced it. An error written
 * for the viewer read well; every other one reached the screen as it was
 * written for the log — "Transcode session request failed (500)", "Data channel
 * request timed out", and once "the proxy accepted the request but sent no
 * video. Nothing here says why — the proxy's own log will." The viewer cannot
 * read that log and cannot act on a status code (torrent-tv/meta#73).
 *
 * So there are two recipients and one rule. An error that already speaks to the
 * viewer — what happened to playback, and what they can do — says so by
 * carrying `viewerFacing: true`, and its message is shown as it is. Any other
 * error is shown as one of two plain statements, chosen by whether Retry is
 * offered, and its own message goes to the log beside the last refusal the
 * proxy stated. Neither statement names a cause: the error that reached here
 * did not establish one in the viewer's terms, and a message must not name a
 * cause it has not established.
 */

/** The two statements shown for an error that was not written for the viewer. */
export const VIEWER_FAILURE_MESSAGES = Object.freeze({
  retryable: "Something went wrong while preparing this video. Press Retry to try again.",
  final: "This video couldn't be played. Choose another file or torrent."
});

/**
 * An error whose message is written for the viewer.
 *
 * @param {string} message - What happened to playback and what the viewer can do.
 * @param {{ canRetry?: boolean }} [options]
 * @returns {Error & { viewerFacing: true, canRetry: boolean }}
 */
export function viewerError(message, { canRetry = false } = {}) {
  return Object.assign(new Error(message), { viewerFacing: true, canRetry });
}

/**
 * Whether an error's message may be shown to the viewer as it is.
 *
 * @param {unknown} error
 * @returns {boolean}
 */
export function isViewerFacing(error) {
  return error instanceof Error && /** @type {{ viewerFacing?: unknown }} */ (error).viewerFacing === true &&
    error.message.trim().length > 0;
}

/**
 * Split a failure into what the viewer is shown and what the log keeps.
 *
 * @param {unknown} error
 * @param {{ canRetry?: boolean, proxyRefusal?: string }} [context] - `canRetry`
 *   overrides the error's own when the caller decides it; `proxyRefusal` is the
 *   last reason the proxy gave for refusing, for the log only.
 * @returns {{ description: string, canRetry: boolean, logDetail: string }}
 *   `logDetail` is empty when the viewer was shown the error's own message and
 *   the proxy stated nothing.
 */
export function describeFailure(error, { canRetry, proxyRefusal = "" } = {}) {
  const retry = typeof canRetry === "boolean"
    ? canRetry
    : /** @type {{ canRetry?: unknown }} */ (error ?? {}).canRetry === true;
  const own = error instanceof Error ? error.message : String(error ?? "");
  const refusal = typeof proxyRefusal === "string" ? proxyRefusal.trim() : "";
  const refusalPart = refusal.length > 0 ? `; the proxy last said: ${refusal}` : "";
  if (isViewerFacing(error)) {
    return { description: own, canRetry: retry, logDetail: refusalPart.slice(2) };
  }
  return {
    description: retry ? VIEWER_FAILURE_MESSAGES.retryable : VIEWER_FAILURE_MESSAGES.final,
    canRetry: retry,
    logDetail: `${own || "no message"}${refusalPart}`
  };
}
