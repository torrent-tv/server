/** @import { WebRtcProxy } from '../../domain/webrtc-proxy.js' */
/** @import { HealthMetrics } from '../../../../proxy/services/health-collector.js' */

import { getDebugState } from "../../shared/debug-state.js";
import { WebRtcProxy } from "../../domain/webrtc-proxy.js";

/**
 * A proxy client candidate as returned by `GET /api/proxy-clients/health`,
 * enriched with computed score and post-connect RTT.
 *
 * @typedef {Object} ProxyCandidate
 * @property {string}          id           - Stable proxy identifier.
 * @property {string}          name         - Human-readable display name.
 * @property {string}          baseUrl      - Advertised HTTP base URL (informational).
 * @property {HealthMetrics | null} metrics - Server-collected health metrics, or `null` on timeout.
 * @property {number | null}   tunnelRttMs  - Server ↔ proxy tunnel round-trip time in ms.
 * @property {number | null}   channelRttMs - Browser ↔ proxy data-channel RTT measured after connect.
 */

/**
 * Proxy selection helper.
 *
 * On-demand flow (called once at playback start):
 *   1. GET /api/proxy-clients/health  – server polls all connected proxies and
 *      returns metrics + tunnel RTT.
 *   2. Score each candidate using server-side data.
 *   3. Connect WebRTC to the best candidate.
 *   4. Measure data-channel RTT for the debug state record.
 *   5. Return the open WebRtcProxy instance ready to use.
 */
export class ProxySelector {
  /**
   * Poll health from all connected proxies, score them, connect via WebRTC
   * to the best candidate, and measure the actual data-channel RTT.
   *
   * Throws when no proxies are available or the WebRTC connection fails. A
   * connection failure carries `error.lanProbeUrl` (the proxy's LAN healthz
   * URL, when a private candidate was seen) so the caller can run the
   * local-network permission flow and retry with `allowPrivateCandidates`.
   *
   * @param {{ allowPrivateCandidates?: boolean, connectTimeoutMs?: number }} [options]
   *   `allowPrivateCandidates: false` = public-only attempt: the proxy's
   *   local-address candidates are dropped, so the browser never asks for the
   *   local-network permission (same-LAN connects via router hairpin when
   *   supported).
   * @returns {Promise<WebRtcProxy>} An open, ready-to-use `WebRtcProxy` instance.
   */
  async chooseBestProxy({ allowPrivateCandidates = true, connectTimeoutMs } = {}) {
    const response = await fetch("/api/proxy-clients/health");
    if (!response.ok) {
      throw new Error(`Proxy health request failed (${response.status}).`);
    }

    const payload = await response.json();
    const raw = Array.isArray(payload.clients) ? payload.clients : [];

    /** @type {Array<ProxyCandidate & { score: number, reachable: boolean | null, sameNetwork: boolean }>} */
    const scored = raw
      .filter((c) => typeof c.id === "string" && c.id.trim().length > 0)
      .map((c) => ({
        id: c.id.trim(),
        name: typeof c.name === "string" ? c.name : c.id,
        baseUrl: typeof c.baseUrl === "string" ? c.baseUrl.trim() : "",
        metrics: c.metrics ?? null,
        tunnelRttMs: typeof c.rttMs === "number" ? c.rttMs : null,
        channelRttMs: null,
        reachable: typeof c.reachable === "boolean" ? c.reachable : null,
        sameNetwork: c.sameNetwork === true,
        score: this.#scoreProxy(c.metrics, c.rttMs)
      }))
      .sort((a, b) => b.score - a.score);

    const debugState = getDebugState();
    debugState.proxies = {
      fetchedAt: new Date().toISOString(),
      candidates: scored.map(({ id, name, score, metrics, tunnelRttMs, reachable, sameNetwork }) => ({
        id, name, score, metrics, tunnelRttMs, reachable, sameNetwork
      })),
      selectedId: ""
    };

    if (scored.length === 0) {
      throw new Error("No proxy clients are available.");
    }

    // Prefer proxies verified reachable from the internet or sitting on the
    // viewer's own network. This is a PREFERENCE, not a filter: a failed
    // inbound-TCP probe does not prove WebRTC cannot connect (hole punching),
    // so when no candidate qualifies, everyone stays eligible.
    const preferred = scored.filter((c) => c.reachable === true || c.sameNetwork === true);
    const pool = preferred.length > 0 ? preferred : scored;
    if (preferred.length === 0 && scored.length > 0) {
      console.info("[proxy-selector] no reachable/same-network proxies; falling back to all candidates");
    }

    const best = pool[0];
    debugState.proxies.selectedId = best.id;

    // The proxy's local HTTP port (from baseUrl) — used to fire a Local Network
    // Access preflight to the proxy's LAN address, so the browser grants the
    // permission that lets WebRTC data flow to a same-LAN private candidate.
    let proxyLocalPort = null;
    try {
      const u = new URL(best.baseUrl);
      const p = parseInt(u.port, 10);
      if (p > 0 && p <= 65535) proxyLocalPort = p;
    } catch { /* baseUrl absent/malformed — preflight is skipped */ }

    const proxy = new WebRtcProxy(best.id, proxyLocalPort, allowPrivateCandidates);
    try {
      await proxy.connect(connectTimeoutMs);
    } catch (error) {
      // Attach the LAN probe URL (when a private candidate was seen) so the
      // caller can run the local-network permission flow and retry, then make
      // sure the failed attempt does not linger.
      if (error instanceof Error) {
        error.lanProbeUrl = proxy.lanProbeUrl;
      }
      proxy.close();
      throw error;
    }

    // Measure actual browser ↔ proxy RTT now that the channel is open.
    try {
      best.channelRttMs = await proxy.ping();
      debugState.proxies.channelRttMs = best.channelRttMs;
    } catch {
      // Non-fatal — proxy is usable even without the RTT measurement.
    }

    return proxy;
  }

  /**
   * Score a proxy candidate using server-collected metrics and tunnel RTT.
   * Higher is better.
   *
   * Weights:
   *   - Free memory (0–1):  40 %  — `memFree * 0.4`
   *   - CPU availability:   40 %  — `(1 - clamp(cpuLoad, 0, 1)) * 0.4`
   *   - Tunnel RTT penalty: 20 %  — `-(rttMs / 2000) * 0.2`
   *
   * When metrics are unavailable the proxy scores `0.1 - rttPenalty` so it
   * remains eligible as a fallback rather than being excluded.
   *
   * @param {HealthMetrics | null} metrics
   * @param {number | null} tunnelRttMs
   * @returns {number}
   */
  #scoreProxy(metrics, tunnelRttMs) {
    // Normalise tunnel RTT to a 0–1 penalty (1 = worst, 0 = 0 ms).
    const rttPenalty = tunnelRttMs != null ? Math.min(1, tunnelRttMs / 2000) : 0.5;

    if (!metrics) {
      return 0.1 - rttPenalty * 0.2;
    }

    // cpuLoad is load-avg / cpu-count; clamp to 0–1 (>1 means overloaded).
    const cpuScore = Math.max(0, 1 - Math.min(1, metrics.cpuLoad));
    const memScore = Math.max(0, Math.min(1, metrics.memFree));

    return memScore * 0.4 + cpuScore * 0.4 - rttPenalty * 0.2;
  }
}
