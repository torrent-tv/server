/**
 * @file Which proxy a viewer is sent to (torrent-tv/meta#36).
 *
 * Decided on the server, from the table of proxies it keeps: each proxy sends
 * its state when it changes, so a choice reads what is already known instead
 * of asking every proxy and waiting. The films a proxy holds never leave this
 * server: the page names the film it is about to open, and is told one proxy.
 *
 * Pure, so the rule can be exercised without a network: the route assembles
 * the candidates, this file chooses among them.
 */

/**
 * @typedef {object} Candidate
 * @property {string} id
 * @property {string} name
 * @property {string} baseUrl
 * @property {{ cpuLoad?: number, memFree?: number, encodeSpeedX?: number | null } | null} metrics
 * @property {number | null} rttMs - The tunnel round trip last measured.
 * @property {boolean | null} reachable - Verified reachable from the internet.
 * @property {boolean} sameNetwork - Shares a public IP with this viewer.
 * @property {boolean} holdsThisFilm - Holds the film being opened.
 */

/**
 * A proxy's standing on its machine alone. Higher is better.
 *
 *   - free memory (0–1): 40 %
 *   - CPU availability (1 − load per processor, clamped): 40 %
 *   - tunnel round trip: −20 % at 2 s and beyond
 *
 * With no state yet the proxy scores `0.1 − round-trip penalty`, so it stays
 * eligible as a fallback rather than being left out.
 *
 * @param {Candidate} candidate
 * @returns {number}
 */
export function scoreProxy({ metrics, rttMs }) {
  const rttPenalty = rttMs != null ? Math.min(1, rttMs / 2000) : 0.5;
  if (!metrics || typeof metrics.cpuLoad !== "number" || typeof metrics.memFree !== "number") {
    return 0.1 - rttPenalty * 0.2;
  }
  const cpuScore = Math.max(0, 1 - Math.min(1, metrics.cpuLoad));
  const memScore = Math.max(0, Math.min(1, metrics.memFree));
  return memScore * 0.4 + cpuScore * 0.4 - rttPenalty * 0.2;
}

/**
 * A proxy has no room for one more encode when what already holds a place on
 * it leaves every output at or below realtime — the proxy's own reading of its
 * admission. Not a figure chosen here: one second of film per second IS keeping
 * up. A proxy that does not report it is not judged by it.
 *
 * @param {Candidate} candidate
 * @returns {boolean}
 */
function hasNoEncodeRoom(candidate) {
  const speed = candidate?.metrics?.encodeSpeedX;
  return typeof speed === "number" && Number.isFinite(speed) && speed <= 1;
}

/**
 * A proxy is saturated when its load average per processor has reached one —
 * `cpuLoad` is defined as the load average divided by the number of
 * processors, so 1 IS fully utilised.
 *
 * @param {Candidate} candidate
 * @returns {boolean}
 */
function isSaturated(candidate) {
  const load = candidate?.metrics?.cpuLoad;
  return typeof load === "number" && load >= 1;
}

/**
 * The candidates worth choosing between, best first. Three preferences in
 * order, none of them a filter: when nothing qualifies, everyone stays.
 *
 * 1. Reachable from the internet, or on the viewer's own network. A failed
 *    inbound probe does not prove WebRTC cannot connect — hole punching
 *    exists — so this narrows the field rather than closing it.
 * 2. With room for one more encode: one without would refuse the viewer when
 *    their output is opened.
 * 3. Holding this film and not saturated. On the proxy that has it a viewer
 *    costs the encode and nothing else; anywhere else they start the download
 *    from nothing. A saturated holder is not preferred, or a popular film
 *    would send everyone to the one proxy that has it.
 *
 * @param {Candidate[]} candidates
 * @returns {{ pool: Candidate[], narrowedBy: string }}
 */
export function choosePool(candidates) {
  const all = [...(Array.isArray(candidates) ? candidates : [])].sort((a, b) => scoreProxy(b) - scoreProxy(a));
  const reachable = all.filter((one) => one?.reachable === true || one?.sameNetwork === true);
  const reachableOrAll = reachable.length > 0 ? reachable : all;
  const withRoom = reachableOrAll.filter((one) => !hasNoEncodeRoom(one));
  const afterRoom = withRoom.length > 0 ? withRoom : reachableOrAll;
  const holders = afterRoom.filter((one) => one?.holdsThisFilm === true && !isSaturated(one));
  const pool = holders.length > 0 ? holders : afterRoom;
  const narrowed = [
    reachable.length > 0 && reachable.length < all.length ? "reachability" : "",
    withRoom.length > 0 && withRoom.length < reachableOrAll.length ? "room" : "",
    holders.length > 0 && holders.length < afterRoom.length ? "content" : ""
  ].filter((reason) => reason !== "");
  return { pool, narrowedBy: narrowed.join("+") };
}

/**
 * The one proxy to connect to.
 *
 * `tried` are proxies this viewer could not connect to on this attempt; they
 * are left out of this choice only. `onlyIds` are the proxies that answered
 * they could sustain this file after another refused it. `current` is the
 * proxy the viewer is connected to already: it is kept whenever it is among
 * the best — holding the film when any proxy with room does — so a page does
 * not reconnect for a difference in load.
 *
 * @param {Candidate[]} candidates
 * @param {{ tried?: string[], onlyIds?: string[] | null, current?: string | null }} [options]
 * @returns {{ chosen: Candidate | null, pool: Candidate[], narrowedBy: string }}
 */
export function chooseProxy(candidates, { tried = [], onlyIds = null, current = null } = {}) {
  const left = (Array.isArray(candidates) ? candidates : [])
    .filter((one) => !tried.includes(one.id))
    .filter((one) => !Array.isArray(onlyIds) || onlyIds.length === 0 || onlyIds.includes(one.id));
  const { pool, narrowedBy } = choosePool(left);
  const kept = current ? pool.find((one) => one.id === current) : undefined;
  return { chosen: kept ?? pool[0] ?? null, pool, narrowedBy };
}
