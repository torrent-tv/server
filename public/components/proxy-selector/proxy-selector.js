/** @import { WebRtcProxy } from '../../domain/webrtc-proxy.js' */

import { getDebugState } from "../../shared/debug-state.js";
import { requestHeaders } from "../../shared/request-headers.js";
import { viewerError } from "../../domain/viewer-failure.js";
import { WebRtcProxy } from "../../domain/webrtc-proxy.js";

// Same-LAN public-only connect budget. When the browser and proxy share a
// public IP, the public-only attempt can only succeed via router hairpin,
// which connects within a couple of seconds or never — so the full connect
// timeout is dead time the viewer stares at before the local-network
// permission walkthrough even appears. Cap it there so we fall through fast.
// Remote viewers (different networks) keep the caller's full timeout, since
// their srflx / port-prediction path genuinely needs it.
const SAME_NETWORK_PUBLIC_CONNECT_TIMEOUT_MS = 5000;

/**
 * A proxy as `POST /api/proxy-clients/choose` names it.
 *
 * @typedef {Object} ChosenProxy
 * @property {string}  id            - Stable proxy identifier.
 * @property {string}  name          - Human-readable display name.
 * @property {string}  baseUrl       - Advertised HTTP base URL; its port is the LAN port.
 * @property {boolean} sameNetwork   - Shares a public IP with this viewer.
 * @property {boolean} holdsThisFilm - Holds the film being opened.
 */

/**
 * Which proxy to connect to, and the connection to it.
 *
 * The SERVER chooses (torrent-tv/meta#36): it keeps a table of the proxies,
 * which each proxy keeps current over its tunnel, and answers one request with
 * one proxy. The page names the film it is about to open; which films any
 * proxy holds never reaches the page. When a proxy cannot be connected to, the
 * page asks again naming it and the error, and is given the next.
 */
export class ProxySelector {
  /**
   * Ask the server which proxy to connect to.
   *
   * @param {{ infoHash?: string, onlyIds?: string[] | null, tried?: Array<{ id: string, error: string }>, current?: string }} about
   * @returns {Promise<{ chosen: ChosenProxy | null, candidates: object[], narrowedBy: string }>}
   */
  async #choose({ infoHash = "", onlyIds = null, tried = [], current = "" } = {}) {
    const response = await fetch("/api/proxy-clients/choose", {
      method: "POST",
      headers: requestHeaders(),
      body: JSON.stringify({
        ...(infoHash ? { infoHash } : {}),
        ...(Array.isArray(onlyIds) && onlyIds.length > 0 ? { onlyIds } : {}),
        ...(tried.length > 0 ? { tried } : {}),
        ...(current ? { current } : {})
      })
    });
    if (!response.ok) {
      throw new Error(`Proxy choice request failed (${response.status}).`);
    }
    const answer = await response.json();
    const debugState = getDebugState();
    debugState.proxies = {
      fetchedAt: new Date().toISOString(),
      candidates: Array.isArray(answer.candidates) ? answer.candidates : [],
      narrowedBy: answer.narrowedBy ?? "",
      tried: tried.map((one) => one.id),
      selectedId: answer.chosen?.id ?? ""
    };
    if (answer.narrowedBy) {
      console.info(`[proxy-selector] chosen from ${debugState.proxies.candidates.length} candidate(s) after ${answer.narrowedBy}`);
    }
    return { chosen: answer.chosen ?? null, candidates: debugState.proxies.candidates, narrowedBy: answer.narrowedBy ?? "" };
  }

  /**
   * Whether the proxy in hand should be left for another one, once the film
   * is known.
   *
   * A proxy is taken the moment the page opens — before any film may exist —
   * so the choice can be made with no film in hand. Field 2026-09-13: two
   * viewers of one film, 76 seconds apart, on two different proxies, each
   * downloading and encoding it separately. The server keeps the current proxy
   * whenever it is among the best — holding the film when a proxy with room
   * does — so the page moves only to a proxy that holds this film and has room
   * while the one in hand does not.
   *
   * @param {{ infoHash?: string, onlyIds?: string[] | null, current?: string }} about
   * @returns {Promise<string>} The id to move to, or "" to stay.
   */
  async betterProxyIdFor(about = {}) {
    try {
      const { chosen } = await this.#choose(about);
      return chosen && chosen.id !== about.current && chosen.holdsThisFilm ? chosen.id : "";
    } catch {
      // silent-ok: a question that cannot be answered leaves the connection in
      // hand alone — it is a preference, not a requirement, and the empty
      // answer IS the result the caller acts on.
      return "";
    }
  }

  /**
   * Connect to the proxy the server chooses, and to the next one when that
   * fails.
   *
   * Throws when no proxy is left or a connection failure needs the caller: a
   * proxy on the viewer's own network that cannot be reached by public
   * addresses is not a reason to try another proxy, it is the cue for the
   * local-network permission flow, so its error (with `error.lanProbeUrl`) is
   * thrown as it was.
   *
   * @param {{ allowPrivateCandidates?: boolean, connectTimeoutMs?: number, onConnecting?: (proxyName: string) => void, infoHash?: string, onlyIds?: string[] | null }} [options]
   *   `allowPrivateCandidates: false` = public-only attempt: the proxy's
   *   local-address candidates are dropped, so the browser never asks for the
   *   local-network permission (same-LAN connects via router hairpin when
   *   supported). `onConnecting` fires once a proxy is chosen and the WebRTC
   *   connect is about to begin. `infoHash` is the film about to be opened,
   *   when known; `onlyIds` the proxies that said they could sustain it after
   *   another refused it.
   * @returns {Promise<WebRtcProxy>} An open, ready-to-use `WebRtcProxy` instance.
   */
  async chooseBestProxy({
    allowPrivateCandidates = true,
    connectTimeoutMs,
    onConnecting,
    infoHash = "",
    onlyIds = null
  } = {}) {
    /** @type {Array<{ id: string, error: string }>} */
    const tried = [];
    for (;;) {
      const { chosen } = await this.#choose({ infoHash, onlyIds, tried });
      if (!chosen) {
        // Said to the viewer: no proxy is connected to the pool at all, or
        // none of them could be reached from here — a fact about now and not
        // about the film.
        throw viewerError("No video source is available right now. Try again later.");
      }
      try {
        return await this.#connect(chosen, { allowPrivateCandidates, connectTimeoutMs, onConnecting });
      } catch (error) {
        if (chosen.sameNetwork) {
          throw error;
        }
        tried.push({ id: chosen.id, error: error instanceof Error ? error.message : String(error) });
        console.warn(`[proxy-selector] could not connect to ${chosen.name}; asking for another (${tried.at(-1).error})`);
      }
    }
  }

  /**
   * Connect to one chosen proxy and prove the channel carries data.
   *
   * @param {ChosenProxy} chosen
   * @param {{ allowPrivateCandidates: boolean, connectTimeoutMs?: number, onConnecting?: (proxyName: string) => void }} options
   * @returns {Promise<WebRtcProxy>}
   */
  async #connect(chosen, { allowPrivateCandidates, connectTimeoutMs, onConnecting }) {
    // The proxy's local HTTP port (from baseUrl) — used to fire a Local Network
    // Access preflight to the proxy's LAN address, so the browser grants the
    // permission that lets WebRTC data flow to a same-LAN private candidate.
    let proxyLocalPort = null;
    try {
      const u = new URL(chosen.baseUrl);
      const p = parseInt(u.port, 10);
      if (p > 0 && p <= 65535) proxyLocalPort = p;
    } catch (error) {
      // Skipping the preflight is not free: it is what prompts Chromium for
      // the local-network permission, and without the permission a same-LAN
      // pair opens a data channel that carries nothing and dies in five
      // seconds. So the address that could not be read is named.
      console.warn(
        `[torrent-tv] no local port for the preflight — the proxy's address could not be read ` +
        `(${error instanceof Error ? error.message : String(error)})`
      );
    }

    // Same-LAN public-only attempts get a short connect budget (hairpin
    // connects fast or never); everyone else keeps the caller's timeout.
    const effectiveConnectTimeoutMs =
      allowPrivateCandidates === false && chosen.sameNetwork
        ? Math.min(connectTimeoutMs ?? SAME_NETWORK_PUBLIC_CONNECT_TIMEOUT_MS, SAME_NETWORK_PUBLIC_CONNECT_TIMEOUT_MS)
        : connectTimeoutMs;
    if (effectiveConnectTimeoutMs !== connectTimeoutMs) {
      console.debug(
        `[proxy-selector] same-network public-only attempt; connect timeout capped to ${effectiveConnectTimeoutMs}ms`
      );
    }

    // The pick is done; what follows (WebRTC connect + liveness ping) is the
    // round-trip cost. Let the caller relabel from "selecting" to "connecting".
    if (typeof onConnecting === "function") {
      onConnecting(chosen.name);
    }

    const proxy = new WebRtcProxy(chosen.id, proxyLocalPort, allowPrivateCandidates);
    try {
      await proxy.connect(effectiveConnectTimeoutMs);
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

    // Liveness gate. A bare "data channel open" is NOT proof the channel can
    // carry data. On a same-LAN pair the browser can nominate a local path
    // (host ↔ peer-reflexive) even in public-only mode — the proxy's LAN
    // address leaks in as a peer-reflexive candidate — and Chromium then blocks
    // the SCTP DATA to that local address without the Local Network permission:
    // the channel opens and dies within milliseconds (observed: a same-LAN
    // Mac/Chrome, "Data channel closed" right after connect). A ping round-trip
    // proves the channel actually moves bytes. On failure this attempt is dead;
    // attach the LAN probe URL so the caller runs the local-network permission
    // flow and retries with local candidates (where the permission makes SCTP
    // flow) instead of surfacing a non-retryable error.
    try {
      const channelRttMs = await proxy.ping();
      getDebugState().proxies.channelRttMs = channelRttMs;
    } catch (pingError) {
      const error = pingError instanceof Error ? pingError : new Error(String(pingError));
      error.lanProbeUrl = proxy.lanProbeUrl;
      proxy.close();
      throw error;
    }

    return proxy;
  }

  /**
   * Rebuild a connection to a specific proxy that was working moments ago
   * (auto-reconnect, same-proxy path). No choice, no permission flow — reuse
   * the exact descriptor (id, LAN port, candidate policy) of the connection
   * that just dropped and dial it again.
   *
   * @param {{ proxyId: string, proxyLocalPort: number | null, allowPrivateCandidates: boolean }} descriptor
   * @param {{ connectTimeoutMs?: number, signal?: AbortSignal }} [options]
   * @returns {Promise<WebRtcProxy>} An open, ready-to-use `WebRtcProxy`.
   */
  async reconnectTo({ proxyId, proxyLocalPort, allowPrivateCandidates }, { connectTimeoutMs, signal } = {}) {
    const proxy = new WebRtcProxy(proxyId, proxyLocalPort ?? null, allowPrivateCandidates !== false);
    try {
      await proxy.connect(connectTimeoutMs, { signal });
    } catch (error) {
      proxy.close();
      throw error;
    }
    return proxy;
  }
}
