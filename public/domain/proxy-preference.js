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
 * @property {{ cpuLoad?: number, encodeSpeedX?: number | null } | null} [metrics]
 */

/**
 * A proxy has no room for one more encode when what already holds a place on
 * it leaves every output at or below realtime — the proxy's own reading of its
 * admission (roadmap item 97, step 14). Not a figure chosen here: one second of
 * film per second IS keeping up. A proxy that does not report it is not judged
 * by it.
 *
 * @param {Candidate} candidate
 * @returns {boolean}
 */
function hasNoEncodeRoom(candidate) {
  const speed = candidate?.metrics?.encodeSpeedX;
  return typeof speed === "number" && Number.isFinite(speed) && speed <= 1;
}

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
 * @returns {{ pool: Candidate[], narrowedBy: string }} `narrowedBy` names, joined by "+", what narrowed the field: "reachability", "room", "content".
 */
export function choosePool(candidates) {
  const all = Array.isArray(candidates) ? candidates : [];
  const reachable = all.filter((one) => one?.reachable === true || one?.sameNetwork === true);
  const reachableOrAll = reachable.length > 0 ? reachable : all;
  // A proxy with no room for one more encode is left out while any other has
  // room: the viewer would be refused there when their output is opened, and
  // moved on after a round trip. Not a filter either — when every proxy is
  // full, every one stays, and the refusal at the opening is what decides.
  const withRoom = reachableOrAll.filter((one) => !hasNoEncodeRoom(one));
  const afterReachability = withRoom.length > 0 ? withRoom : reachableOrAll;

  const holders = afterReachability.filter((one) => one?.holdsThisFilm === true && !isSaturated(one));
  const pool = holders.length > 0 ? holders : afterReachability;

  const narrowed = [
    reachable.length > 0 && reachable.length < all.length ? "reachability" : "",
    withRoom.length > 0 && withRoom.length < reachableOrAll.length ? "room" : "",
    holders.length > 0 && holders.length < afterReachability.length ? "content" : ""
  ].filter((reason) => reason !== "");

  return { pool, narrowedBy: /** @type {any} */ (narrowed.join("+")) };
}
