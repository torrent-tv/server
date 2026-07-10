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

/** @import { ProxyTransport } from './proxy-transport.js' */

import { recordNetSample } from "./net-report.js";

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
 * Takes the {@link ProxyTransport} (not the raw `WebRtcProxy`) so that a
 * seamless reconnect — `transport.replaceWebRtcProxy(next)` — transparently
 * redirects this loader's fetches to the new channel: the running HLS.js
 * instance keeps its loader, and the next manifest/segment load goes over the
 * reconnected proxy with no player rebuild.
 *
 * Pass the returned class as `{ loader: class }` in the HLS.js config:
 * ```js
 * const Hls = new HlsClass({ loader: createWebRtcHlsLoader(transport) });
 * ```
 *
 * @param {ProxyTransport} transport - The WebRTC-backed proxy transport.
 * @returns {HlsLoaderClass}
 */
export function createWebRtcHlsLoader(transport) {
  return class WebRtcHlsLoader {
    constructor() {
      this._aborted = false;
      /**
       * Public stats object required by HLS.js internals (e.g. ABR controller
       * `_abandonRulesCheck`). HLS.js assigns `frag.stats = loader.stats` before
       * calling `load()`, so this must be a plain object with the full
       * LoaderStats shape (not a class field, to avoid initialisation ordering
       * issues with class-in-function patterns).
       */
      this.stats = {
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
    }

    /**
     * @param {object} context - HLS.js loader context ({ url, responseType, … }).
     * @param {object} _config  - HLS.js loader config (unused).
     * @param {{ onSuccess: Function, onError: Function, onTimeout: Function }} callbacks
     */
    load(context, _config, callbacks) {
      this._aborted = false;
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
        fetchPromise = transport.fetch(path);
      } catch (syncErr) {
        if (!this._aborted) {
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
          if (this._aborted) return;

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

          if (this._aborted) return;

          const endedAt = performance.now();
          const byteLength = typeof data === "string" ? data.length : data.byteLength;

          // [net-debug] TEMPORARY: measure data-channel transfer time/throughput
          // per resource to locate the slow-start bottleneck.
          const ms = endedAt - startedAt;
          const mbps = ms > 0 ? ((byteLength * 8) / (ms / 1000) / 1e6) : 0;
          console.debug("[net-debug] dc-load", {
            t: new Date().toISOString().slice(11, 23), // UTC HH:MM:SS.mmm — matches proxy logs
            path,
            type: context.responseType,
            bytes: byteLength,
            ms: Math.round(ms),
            mbps: Number(mbps.toFixed(2))
          });

          // Feed the viewer net reporter (adaptive bitrate): media segments
          // only — playlists are tiny and would skew the link estimate.
          if (context.responseType === "arraybuffer") {
            recordNetSample(byteLength, ms);
          }

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
          if (this._aborted) return;
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
      this._aborted = true;
    }

    destroy() {
      this._aborted = true;
    }
  };
}
