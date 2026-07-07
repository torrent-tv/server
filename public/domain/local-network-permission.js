/**
 * @file Local-network permission helpers (Chromium's Local Network Access).
 *
 * Chromium asks the user before a web page may talk to addresses inside the
 * user's own network (192.168.x.x and similar). WebRTC ICE and DTLS work
 * without the permission, but the actual DATA to a local address is blocked
 * until it is granted — a same-LAN data channel opens, carries nothing and
 * dies within seconds. Firefox has no such mechanism (nothing is ever asked).
 *
 * The page cannot show the browser's question directly; it appears when the
 * page performs a local-network request. `probeLocalNetwork` performs exactly
 * that request — fired from a button click, so the question reliably appears.
 */

/**
 * Current state of the local-network permission.
 *
 * @returns {Promise<"granted" | "prompt" | "denied" | "unsupported">}
 *   "unsupported" = the browser has no such permission (Firefox, Safari,
 *   older Chromium) — local addresses work without asking.
 */
export async function queryLocalNetworkPermission() {
  try {
    const status = await navigator.permissions.query({ name: "local-network-access" });
    return status.state;
  } catch {
    return "unsupported";
  }
}

/**
 * Perform one local-network request to the proxy's LAN address, which makes
 * the browser show its permission question (when the state is "prompt").
 * `targetAddressSpace: "local"` marks the request as intentionally local —
 * without it an http:// request from an https page is silently blocked.
 *
 * Resolves after the request settles either way; the caller re-checks the
 * permission state afterwards.
 *
 * @param {string} url - `http://<proxy-lan-ip>:<port>/healthz`.
 * @param {number} [timeoutMs=15000] - Generous: the user is reading the browser's question.
 * @returns {Promise<boolean>} Whether the request itself succeeded.
 */
export async function probeLocalNetwork(url, timeoutMs = 15_000) {
  try {
    await fetch(url, { mode: "cors", targetAddressSpace: "local", signal: AbortSignal.timeout(timeoutMs) });
    return true;
  } catch {
    return false;
  }
}
