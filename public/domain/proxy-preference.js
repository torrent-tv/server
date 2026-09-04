/**
 * @file Which of the proxies that answered may be chosen.
 *
 * Two preferences, applied in order, and neither is a filter: when nothing
 * qualifies, everyone stays eligible. A filter here would leave a viewer with no
 * proxy at all in exactly the cases that are hardest to reproduce.
 *
 * Pure and importable, so the rule can be exercised without a browser — the same
 * shape as `url-state.js`. The scoring itself stays in the component: it reads
 * the numbers the server sent and nothing else.
 */

/**
 * @typedef {Object} Candidate
 * @property {string} id
 * @property {boolean | null} reachable - Verified reachable from the internet.
 * @property {boolean} sameNetwork - Shares a public IP with this viewer.
 * @property {boolean} [holdsThisFilm] - Already downloading the film being opened.
 * @property {{ cpuLoad?: number } | null} [metrics]
 */

/**
 * A proxy is saturated when its load average per processor has reached one.
 *
 * Not a figure chosen here: `cpuLoad` is defined as the load average divided by
 * the number of processors, so 1 IS "fully utilised" by the definition of what
 * is being reported.
 *
 * @param {Candidate} candidate
 * @returns {boolean}
 */
function isSaturated(candidate) {
  const load = candidate?.metrics?.cpuLoad;
  return typeof load === "number" && load >= 1;
}

/**
 * The candidates worth choosing between, best-first order preserved.
 *
 * 1. Reachable from the internet, or on the viewer's own network. A failed
 *    inbound probe does not prove WebRTC cannot connect — hole punching exists —
 *    so this narrows the field rather than closing it.
 * 2. Among those, one that is ALREADY downloading this film. Everything the
 *    score reads is about the machine and none of it is about the film, so two
 *    strangers watching one film land together only by chance. On the proxy that
 *    has it, a second viewer costs the encode and nothing else; anywhere else
 *    they start the download from nothing. A saturated holder is not preferred,
 *    or a popular film would send everyone to the one proxy that has it.
 *
 * @param {Candidate[]} candidates - Already sorted, best first.
 * @returns {{ pool: Candidate[], narrowedBy: "" | "reachability" | "content" | "reachability+content" }}
 */
export function choosePool(candidates) {
  const all = Array.isArray(candidates) ? candidates : [];
  const reachable = all.filter((one) => one?.reachable === true || one?.sameNetwork === true);
  const afterReachability = reachable.length > 0 ? reachable : all;

  const holders = afterReachability.filter((one) => one?.holdsThisFilm === true && !isSaturated(one));
  const pool = holders.length > 0 ? holders : afterReachability;

  const narrowed = [
    reachable.length > 0 && reachable.length < all.length ? "reachability" : "",
    holders.length > 0 && holders.length < afterReachability.length ? "content" : ""
  ].filter((reason) => reason !== "");

  return { pool, narrowedBy: /** @type {any} */ (narrowed.join("+")) };
}
