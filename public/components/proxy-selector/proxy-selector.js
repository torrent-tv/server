import { getDebugState } from "../../shared/debug-state.js";

/**
 * Proxy selection helper.
 *
 * Responsibilities:
 * - Fetch proxy clients list from registry API.
 * - Probe proxy health via server-side relay (no direct browser→proxy connection).
 * - Score and pick the best proxy, returning a relay base URL.
 */
export class ProxySelector {
  async chooseBestBaseUrl() {
    const response = await fetch("/api/proxy-clients");
    if (!response.ok) {
      throw new Error(`Proxy list request failed (${response.status}).`);
    }

    const payload = await response.json();
    const clients = Array.isArray(payload.clients) ? payload.clients : [];
    const scored = [];

    for (const client of clients) {
      const id = typeof client.id === "string" ? client.id.trim() : "";
      if (!id) {
        continue;
      }
      const relayBaseUrl = `${window.location.origin}/api/proxy-relay/${encodeURIComponent(id)}`;
      const probe = await this.#probeProxy(relayBaseUrl);
      if (!probe.reachable) {
        continue;
      }
      scored.push({
        baseUrl: relayBaseUrl,
        score: this.#computeProxyScore(probe),
        probe
      });
    }

    const debugState = getDebugState();
    debugState.proxies = {
      fetchedAt: new Date().toISOString(),
      clients,
      scored: scored.map((item) => ({
        baseUrl: item.baseUrl,
        score: item.score,
        probe: item.probe
      })),
      selectedBaseUrl: ""
    };

    if (scored.length === 0) {
      return "";
    }
    scored.sort((left, right) => right.score - left.score);
    debugState.proxies.selectedBaseUrl = scored[0].baseUrl;
    return scored[0].baseUrl;
  }

  async #probeProxy(relayBaseUrl) {
    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), 5000);
    const startedAt = performance.now();
    try {
      const response = await fetch(`${relayBaseUrl}/health`, {
        method: "GET",
        signal: controller.signal
      });
      if (!response.ok) {
        return { reachable: false, latencyMs: performance.now() - startedAt, cpuFree: null, bandwidthFree: null };
      }

      let payload = {};
      try {
        payload = await response.json();
      } catch (_error) {
        payload = {};
      }

      return {
        reachable: true,
        latencyMs: performance.now() - startedAt,
        cpuFree: this.#pickMetric(payload, ["cpuFree", "metrics.cpuFree", "system.cpuFree"]),
        bandwidthFree: this.#pickMetric(payload, ["bandwidthFree", "metrics.bandwidthFree", "network.bandwidthFree"])
      };
    } catch (_error) {
      return { reachable: false, latencyMs: performance.now() - startedAt, cpuFree: null, bandwidthFree: null };
    } finally {
      window.clearTimeout(timeoutId);
    }
  }

  #pickMetric(payload, paths) {
    for (const path of paths) {
      const value = this.#getNestedValue(payload, path);
      if (typeof value === "number" && Number.isFinite(value)) {
        return value;
      }
    }
    return null;
  }

  #getNestedValue(source, path) {
    const parts = path.split(".");
    let current = source;
    for (const part of parts) {
      if (!current || typeof current !== "object" || !(part in current)) {
        return undefined;
      }
      current = current[part];
    }
    return current;
  }

  #normalizePercent(value) {
    if (value == null) {
      return null;
    }
    if (value <= 1) {
      return Math.max(0, Math.min(1, value));
    }
    return Math.max(0, Math.min(1, value / 100));
  }

  #computeProxyScore(probe) {
    const cpuNorm = this.#normalizePercent(probe.cpuFree);
    const bwNorm = this.#normalizePercent(probe.bandwidthFree);
    const latencyPenalty = Math.min(1, probe.latencyMs / 5000);

    if (cpuNorm != null && bwNorm != null) {
      return bwNorm * 0.6 + cpuNorm * 0.4 - latencyPenalty * 0.2;
    }
    if (cpuNorm != null) {
      return cpuNorm - latencyPenalty * 0.2;
    }
    if (bwNorm != null) {
      return bwNorm - latencyPenalty * 0.2;
    }
    return 0.2 - latencyPenalty;
  }
}
