/**
 * @file The last thing the proxy said when it refused to serve a segment.
 *
 * WHY THIS EXISTS. A start-up that runs out of patience told the viewer "the
 * proxy accepted the request but sent no video. Nothing here says why — the
 * proxy's own log will." The viewer cannot read that log, and on 2026-09-14 the
 * proxy had said why in the same millisecond it refused: the segment the
 * browser was asking for was ranked last of a hundred, because nothing was
 * making it. The reason existed for sixty seconds before the failure and
 * travelled nowhere.
 *
 * So a refusal carries its reason in the response, this holds the last one, and
 * the failure shown to the viewer says it. One fact, one writer — whoever reads
 * the proxy's answers — and it is cleared when a request succeeds, so a stale
 * reason cannot be attached to a later, different failure.
 */

/** @type {{ text: string, at: number } | null} */
let last = null;

/**
 * Record what the proxy said when it refused.
 *
 * @param {string} text
 * @returns {void}
 */
export function noteProxyRefusal(text) {
  const said = typeof text === "string" ? text.trim() : "";
  last = said.length > 0 ? { text: said, at: Date.now() } : last;
}

/**
 * Forget it: something was served, so whatever was refused before is over.
 *
 * @returns {void}
 */
export function clearProxyRefusal() {
  last = null;
}

/**
 * What the proxy last said, or an empty string when it has said nothing.
 *
 * @returns {string}
 */
export function lastProxyRefusal() {
  return last === null ? "" : last.text;
}
