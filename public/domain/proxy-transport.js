/**
 * @file Transport abstraction for proxy API calls.
 *
 * Decouples `TorrentSession` (and `waitForHlsPlaylist`) from the underlying
 * network layer so the same session logic works whether the proxy is reached
 * via a direct HTTP connection or a WebRTC data channel.
 *
 * Both transports expose a `fetch(path, options)` method that mirrors the
 * browser Fetch API, but accepts a **path relative to the proxy root** rather
 * than a full URL.
 *
 * ## Creating transports
 *
 * ```js
 * // Direct HTTP (proxy reachable on the local network):
 * const t = ProxyTransport.fromHttp("http://192.168.1.5:9090");
 *
 * // WebRTC data channel (proxy behind NAT):
 * const t = ProxyTransport.fromWebRtc(webRtcProxy);
 * ```
 *
 * ## Fake base URL for WebRTC
 *
 * WebRTC transports use `http://webrtc-proxy/` as their `baseUrl`.
 * This value is purely nominal — it is never fetched directly.
 * `url(path)` still works and produces a string that the HLS custom loader
 * parses to extract the path, then routes through the data channel.
 * Use `transport.isHttp` to distinguish the two kinds.
 */

/** @import { WebRtcProxy } from './webrtc-proxy.js' */

/**
 * A function that performs a fetch-like operation against the proxy.
 *
 * @callback ProxyFetchFn
 * @param {string}  path    - Absolute path on the proxy, e.g. `"/api/sources"`.
 * @param {object}  [options] - Fetch options forwarded to the underlying transport.
 * @returns {Promise<Response>}
 */

/**
 * Construction parameters for a {@link ProxyTransport}.
 *
 * @typedef {Object} ProxyTransportInit
 * @property {ProxyFetchFn} fetchFn - Transport-specific fetch implementation.
 * @property {string}       baseUrl - Base URL used by `url()` for path expansion.
 */

export class ProxyTransport {
  /** @type {ProxyFetchFn} */
  #fetchFn;
  /** @type {string} */
  #baseUrl;

  /**
   * @param {ProxyTransportInit} params
   */
  constructor({ fetchFn, baseUrl }) {
    this.#fetchFn = fetchFn;
    this.#baseUrl = baseUrl;
  }

  /**
   * Fetch a path on the proxy.
   *
   * @param {string} path    - Absolute path on the proxy, e.g. `"/api/sources"`.
   * @param {object} [options] - Fetch options (method, headers, body, signal, …).
   * @returns {Promise<Response>}
   */
  fetch(path, options = {}) {
    return this.#fetchFn(path, options);
  }

  /**
   * Build a full URL string for a path on this proxy.
   *
   * For WebRTC transports the returned URL has a fake hostname and is used only
   * as an opaque string — the HLS.js custom loader extracts the path from it and
   * routes the request through the data channel.  Do not pass this URL to the
   * global `fetch()` directly.
   *
   * @param {string} path - e.g. `"/transcode/abc123/index.m3u8"`
   * @returns {string}
   */
  url(path) {
    const base = this.#baseUrl.endsWith("/") ? this.#baseUrl : `${this.#baseUrl}/`;
    return new URL(path.replace(/^\/+/, ""), base).toString();
  }

  /**
   * The proxy's base URL.
   * May be the nominal `"http://webrtc-proxy/"` for WebRTC transports.
   *
   * @returns {string}
   */
  get baseUrl() {
    return this.#baseUrl;
  }

  /**
   * `true` when backed by a real HTTP connection.
   * Use to decide whether to attempt `navigator.sendBeacon` on page unload,
   * or to skip direct-URL probing (WebRTC uses a fake URL that the `<video>`
   * element cannot play).
   *
   * @returns {boolean}
   */
  get isHttp() {
    return this.#baseUrl !== "http://webrtc-proxy/";
  }

  /**
   * Create a transport backed by a direct HTTP connection to the proxy.
   *
   * `signal` is the fallback `AbortSignal` used when the caller does not
   * supply one per-call.  A per-call `options.signal` always takes priority.
   *
   * @param {string}       baseUrl
   * @param {AbortSignal}  [signal] - Optional transport-level abort signal.
   * @returns {ProxyTransport}
   */
  static fromHttp(baseUrl, signal) {
    const base = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
    return new ProxyTransport({
      baseUrl,
      fetchFn: (path, options = {}) => {
        const url = new URL(path.replace(/^\/+/, ""), base);
        // Per-call signal takes priority; fall back to transport-level signal.
        const effectiveSignal = options.signal !== undefined ? options.signal : signal;
        return fetch(url.toString(), { ...options, signal: effectiveSignal });
      }
    });
  }

  /**
   * Create a transport backed by a WebRTC data channel.
   *
   * A fixed fake base URL (`http://webrtc-proxy/`) is used for `url()` — the
   * data channel handler on the proxy side ignores the host and routes by path
   * only.
   *
   * @param {WebRtcProxy} proxy - An open `WebRtcProxy` instance.
   * @returns {ProxyTransport}
   */
  static fromWebRtc(proxy) {
    return new ProxyTransport({
      baseUrl: "http://webrtc-proxy/",
      fetchFn: (path, options) => proxy.fetch(path, options)
    });
  }
}
