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
     * Public stats object required by HLS.js internals (e.g. ABR controller).
     * Must be initialised before load() is called and kept current throughout
     * the request so that HLS.js can inspect loading timings at any point.
     *
     * @type {{
     *   aborted: boolean, retry: number, total: number, loaded: number,
     *   chunkCount: number, bwEstimate: number,
     *   loading:   { start: number, first: number, end: number },
     *   parsing:   { start: number, end: number },
     *   buffering: { start: number, first: number, end: number }
     * }}
     */
    stats = {
      aborted: false,
      retry: 0,
      total: 0,
      loaded: 0,
      chunkCount: 0,
      bwEstimate: 0,
      loading:   { start: 0, first: 0, end: 0 },
      parsing:   { start: 0, end: 0 },
      buffering: { start: 0, first: 0, end: 0 }
    };

    /**
     * @param {object} context - HLS.js loader context ({ url, responseType, … }).
     * @param {object} _config  - HLS.js loader config (unused).
     * @param {{ onSuccess: Function, onError: Function, onTimeout: Function }} callbacks
     */
    load(context, _config, callbacks) {
      this.#aborted = false;
      const startedAt = performance.now();
      this.stats.loading.start = startedAt;
      this.stats.loading.first = startedAt;
      const parsed = new URL(context.url);
      const path = parsed.pathname + parsed.search;

      // proxy.fetch() is expected to return a Promise, but wrap the call in
      // try-catch for defense-in-depth: if it somehow throws synchronously
      // (e.g. before the channel.send() guard in WebRtcProxy), propagate the
      // error via callbacks.onError so HLS.js handles it gracefully instead of
      // the exception escaping the loader and causing an internalException.
      let fetchPromise;
      try {
        fetchPromise = proxy.fetch(path);
      } catch (syncErr) {
        if (!this.#aborted) {
          callbacks.onError(
            { code: 0, text: syncErr?.message ?? String(syncErr) },
            context,
            null
          );
        }
        return;
      }

      // Track whether onSuccess was called so the .catch() below does not
      // mistakenly turn an exception thrown *inside* callbacks.onSuccess() into
      // a callbacks.onError() call.  HLS.js wraps its own event handlers in a
      // try-catch and reports internal exceptions via its own error pipeline
      // (ErrorDetails.INTERNAL_EXCEPTION); converting them to onError here
      // would produce a spurious manifestLoadError instead.
      let successCalled = false;

      fetchPromise
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

          // Update the public stats so ABR controller sees accurate timings.
          this.stats.loaded = byteLength;
          this.stats.total = byteLength;
          this.stats.loading.first = startedAt;
          this.stats.loading.end = endedAt;

          successCalled = true;
          callbacks.onSuccess(
            { data, url: context.url },
            {
              aborted: false,
              retry: 0,
              chunkCount: 0,
              bwEstimate: 0,
              loaded: byteLength,
              total: byteLength,
              loading: { start: startedAt, first: startedAt, end: endedAt },
              parsing: { start: 0, end: 0 },
              buffering: { start: 0, first: 0, end: 0 }
            },
            context,
            null
          );
        })
        .catch((error) => {
          if (this.#aborted) return;
          // If onSuccess was already called, the exception originated inside
          // HLS.js internals — do not report it as a load error; HLS.js handles
          // it through its own error pipeline.
          if (successCalled) return;
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
