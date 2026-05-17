/**
 * @file Custom HLS.js loader that routes all requests (manifests + segments)
 * through a WebRTC data channel instead of XHR/Fetch.
 *
 * HLS.js expects a loader class with three methods:
 *   `load(context, config, callbacks)` — start the request
 *   `abort()`                          — cancel an in-flight request
 *   `destroy()`                        — tear down (same as abort)
 *
 * The `context.url` contains the full URL, which will be the fake
 * `"http://webrtc-proxy/…"` value produced by `ProxyTransport.url()`.
 * We extract only the path+query and forward them over the data channel.
 *
 * HLS.js signals the expected response format via `context.responseType`:
 *   `"text"`        — manifest / playlist (M3U8), expects `data: string`
 *   `"arraybuffer"` — media segment (TS/fMP4), expects `data: ArrayBuffer`
 */

/** @import { WebRtcProxy } from './webrtc-proxy.js' */

/**
 * The loader context object passed by HLS.js to `load()`.
 *
 * @typedef {Object} HlsLoaderContext
 * @property {string}  url          - Full URL of the resource (may be fake for WebRTC).
 * @property {string}  responseType - `"text"` for playlists, `"arraybuffer"` for segments.
 */

/**
 * Timing/progress statistics passed to the `onSuccess` callback.
 *
 * @typedef {Object} HlsLoadStats
 * @property {{ start: number, first: number, end: number }} loading
 * @property {number} loaded  - Number of bytes/characters received.
 * @property {number} total   - Same as `loaded` (streaming — no Content-Length).
 */

/**
 * The callbacks object supplied by HLS.js to `load()`.
 *
 * @typedef {Object} HlsLoaderCallbacks
 * @property {(response: { data: string | ArrayBuffer, url: string }, stats: HlsLoadStats, context: HlsLoaderContext, networkDetails: null) => void} onSuccess
 * @property {(error: { code: number, text: string }, context: HlsLoaderContext, networkDetails: null) => void} onError
 * @property {(stats: HlsLoadStats, context: HlsLoaderContext, networkDetails: null) => void} onTimeout
 */

/**
 * The minimal interface that HLS.js expects from a custom loader constructor.
 *
 * @typedef {new () => { load: (context: HlsLoaderContext, config: object, callbacks: HlsLoaderCallbacks) => void, abort: () => void, destroy: () => void }} HlsLoaderClass
 */

/**
 * Create a custom HLS.js loader class backed by a WebRTC proxy data channel.
 *
 * Pass the returned class as `{ loader: class }` in the HLS.js config:
 * ```js
 * const Hls = new HlsClass({ loader: createWebRtcHlsLoader(proxy) });
 * ```
 *
 * @param {WebRtcProxy} proxy - An open `WebRtcProxy` instance.
 * @returns {HlsLoaderClass}
 */
export function createWebRtcHlsLoader(proxy) {
  return class WebRtcHlsLoader {
    /** @type {boolean} */
    #aborted = false;

    /**
     * @param {object} context - HLS.js loader context ({ url, responseType, … }).
     * @param {object} _config  - HLS.js loader config (unused).
     * @param {{ onSuccess: Function, onError: Function, onTimeout: Function }} callbacks
     */
    load(context, _config, callbacks) {
      this.#aborted = false;
      const startedAt = performance.now();
      const parsed = new URL(context.url);
      const path = parsed.pathname + parsed.search;

      proxy.fetch(path)
        .then(async (response) => {
          if (this.#aborted) return;

          if (!response.ok) {
            callbacks.onError(
              { code: response.status, text: `HTTP ${response.status}` },
              context,
              null
            );
            return;
          }

          let data;
          if (context.responseType === "arraybuffer") {
            data = await response.arrayBuffer();
          } else {
            data = await response.text();
          }

          if (this.#aborted) return;

          const endedAt = performance.now();
          const byteLength = typeof data === "string" ? data.length : data.byteLength;
          callbacks.onSuccess(
            { data, url: context.url },
            {
              loading: { start: startedAt, first: startedAt, end: endedAt },
              loaded: byteLength,
              total: byteLength
            },
            context,
            null
          );
        })
        .catch((error) => {
          if (this.#aborted) return;
          callbacks.onError(
            { code: 0, text: error?.message ?? String(error) },
            context,
            null
          );
        });
    }

    abort() {
      this.#aborted = true;
    }

    destroy() {
      this.#aborted = true;
    }
  };
}
