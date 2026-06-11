/**
 * @file Dial-back reachability probe.
 *
 * When a proxy reports the port it opened on its home router (via UPnP/NAT-PMP),
 * the server connects to that public endpoint **from the droplet** — the same
 * external vantage a real viewer has — and checks `GET /healthz` returns 200.
 * Only then is the endpoint considered usable from the internet.
 *
 * This is the automated version of the manual check
 * (`curl http://<proxy-ip>:<port>/healthz` from the server). A router can accept
 * a UPnP mapping that is still not reachable (CGNAT, double NAT), so the report
 * alone is not enough — the dial-back is the source of truth.
 */

import { nowIso } from "../utils/time.js";

/** How long to wait for the proxy's /healthz before declaring it unreachable. */
const PROBE_TIMEOUT_MS = 5_000;
/** Re-probe connected proxies on this interval (IP/lease can change silently). */
const REPROBE_INTERVAL_MS = 5 * 60_000;

/**
 * @typedef {Object} ProxyEndpoint
 * @property {string | null} externalIp
 * @property {number}        externalPort
 * @property {"TCP" | "UDP"} protocol
 */

/**
 * Build the dial-back URL for an endpoint, or null if it cannot be probed
 * over HTTP (no external IP, or a UDP-only mapping).
 *
 * @param {ProxyEndpoint} endpoint
 * @returns {string | null}
 */
function buildProbeUrl(endpoint) {
  if (!endpoint || typeof endpoint.externalPort !== "number") {
    return null;
  }
  if (!endpoint.externalIp) {
    return null;
  }
  if (endpoint.protocol && endpoint.protocol.toUpperCase() === "UDP") {
    return null;
  }
  // IPv6 literals must be bracketed in a URL.
  const host = endpoint.externalIp.includes(":") ? `[${endpoint.externalIp}]` : endpoint.externalIp;
  return `http://${host}:${endpoint.externalPort}/healthz`;
}

/**
 * Create the reachability prober.
 *
 * @param {object} deps
 * @param {import("../store/proxy-clients-store.js").ProxyClientsStore} deps.clientsStore
 * @param {import("./proxy-tunnel-server.js").ProxyTunnelServer} deps.tunnelServer
 * @returns {{ probe: (proxyId: string, endpoint: ProxyEndpoint) => Promise<void>, start: () => void, stop: () => void }}
 */
export function createReachabilityProber({ clientsStore, tunnelServer }) {
  /** @type {ReturnType<typeof setInterval> | null} */
  let reprobeTimer = null;

  /**
   * Dial back to a proxy's reported endpoint and record the result.
   *
   * @param {string} proxyId
   * @param {ProxyEndpoint} endpoint
   * @returns {Promise<void>}
   */
  async function probe(proxyId, endpoint) {
    const url = buildProbeUrl(endpoint);
    if (!url) {
      // Endpoint cannot be probed over HTTP (no public IP yet, or UDP-only).
      // Record the endpoint but leave reachability unknown.
      clientsStore.setReachability(proxyId, { endpoint, reachable: null, lastProbedAt: nowIso() });
      console.log(`[reachability] ${proxyId}: endpoint not HTTP-probeable (${JSON.stringify(endpoint)}); reachable=unknown`);
      return;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
    const startedAt = Date.now();
    let reachable = false;
    try {
      const response = await fetch(url, { method: "GET", signal: controller.signal, redirect: "manual" });
      reachable = response.status === 200;
    } catch {
      reachable = false;
    } finally {
      clearTimeout(timer);
    }

    clientsStore.setReachability(proxyId, { endpoint, reachable, lastProbedAt: nowIso() });
    const ms = Date.now() - startedAt;
    console.log(
      `[reachability] ${proxyId}: ${url} → ${reachable ? "reachable" : "unreachable"} (${ms}ms)`
    );
  }

  /**
   * Re-probe every connected proxy that has a stored endpoint. Disconnected
   * proxies are skipped (they cannot serve a viewer anyway).
   *
   * @returns {Promise<void>}
   */
  async function reprobeAll() {
    const candidates = clientsStore
      .listClients()
      .filter((client) => client.endpoint && tunnelServer.isConnected(client.id));
    await Promise.all(candidates.map((client) => probe(client.id, client.endpoint)));
  }

  return {
    probe,

    /**
     * Start the periodic re-probe loop. Idempotent.
     *
     * @returns {void}
     */
    start() {
      if (reprobeTimer) {
        return;
      }
      reprobeTimer = setInterval(() => {
        void reprobeAll().catch((error) => {
          const message = error instanceof Error ? error.message : String(error);
          console.log(`[reachability] re-probe sweep failed: ${message}`);
        });
      }, REPROBE_INTERVAL_MS);
      reprobeTimer.unref?.();
    },

    /**
     * Stop the periodic re-probe loop.
     *
     * @returns {void}
     */
    stop() {
      if (reprobeTimer) {
        clearInterval(reprobeTimer);
        reprobeTimer = null;
      }
    }
  };
}
