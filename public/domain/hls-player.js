/**
 * @file HLS player wrapper.
 *
 * Wraps the global HLS.js instance (loaded via a `<script>` tag) and falls
 * back to native HLS support on Safari.  Accepts an optional custom `loader`
 * class so that manifest and segment fetches can be routed through an
 * alternative transport — e.g. a WebRTC data channel instead of XHR/Fetch.
 */

/** @import { HlsLoaderClass } from './webrtc-hls-loader.js' */

/**
 * @param {HTMLVideoElement} videoElement
 * @returns {boolean}
 */
function isNativeHlsSupported(videoElement) {
  return videoElement.canPlayType("application/vnd.apple.mpegurl") !== "";
}

/**
 * Create a stateful HLS player instance.
 *
 * @param {(message: string) => void} onLog - Called with status/error messages
 *   emitted by the HLS.js event handler.
 * @returns {{ clear: () => void, isActive: () => boolean, stopLoad: () => void, startLoad: () => void, play: (videoElement: HTMLVideoElement, manifestUrl: string, options?: { loader?: HlsLoaderClass }) => Promise<void> }}
 */
export function createHlsPlayer(onLog) {
  let hlsInstance = null;

  return {
    /** Destroy any active HLS.js instance and release its resources. */
    clear() {
      if (hlsInstance) {
        hlsInstance.destroy();
        hlsInstance = null;
      }
    },
    /**
     * `true` when an hls.js instance is currently active (i.e. NOT the native
     * HLS fallback and not cleared). Seamless reconnect — stopLoad/swap/
     * startLoad — only works with an hls.js instance, so the caller gates on
     * this.
     *
     * @returns {boolean}
     */
    isActive() {
      return hlsInstance !== null;
    },
    /**
     * Freeze manifest/segment fetching while keeping the current buffer and
     * playback intact (used during a seamless reconnect). No-op for native
     * HLS (Safari) or when no instance is active.
     */
    stopLoad() {
      if (hlsInstance) {
        hlsInstance.stopLoad();
      }
    },
    /**
     * Resume fetching from the current playback position after a
     * {@link stopLoad} (seamless reconnect). No-op for native HLS or when no
     * instance is active.
     */
    startLoad() {
      if (hlsInstance) {
        hlsInstance.startLoad(-1);
      }
    },
    /**
     * Start HLS playback on `videoElement`.
     *
     * Uses HLS.js when available (Chrome / Firefox / Edge).  Falls back to
     * native HLS (`<video src="…m3u8">`) on Safari.  Resolves once the
     * manifest has been parsed and the video element has started playing.
     *
     * @param {HTMLVideoElement} videoElement
     * @param {string} manifestUrl
     * @param {{ loader?: HlsLoaderClass }} [options]
     *   Pass `{ loader: createWebRtcHlsLoader(proxy) }` when segments and
     *   manifests must be fetched through a WebRTC data channel.
     * @returns {Promise<void>}
     */
    async play(videoElement, manifestUrl, options = {}) {
      this.clear();

      const HlsClass = globalThis.Hls;
      const hlsSupported = !!(HlsClass && typeof HlsClass.isSupported === "function" && HlsClass.isSupported());
      // Prefer hls.js where available (Chrome/Firefox). Native HLS fallback is for Safari.
      if (hlsSupported) {
        // Extend the fragment-load retry budget. The source is torrent-backed:
        // a seek into not-yet-downloaded data, or a fragment whose ffmpeg
        // segment is still warming, briefly fails to load. The default policy
        // gives up after a few quick retries and goes fatal; a wider budget lets
        // hls.js keep re-requesting until the pieces arrive, so a transient
        // stall self-heals instead of killing the stream. Based on the default
        // policy so unrelated fields (timeoutRetry) are preserved.
        const baseFragPolicy = HlsClass.DefaultConfig?.fragLoadPolicy;
        const fragLoadPolicy = baseFragPolicy
          ? {
              default: {
                ...baseFragPolicy.default,
                errorRetry: {
                  ...baseFragPolicy.default?.errorRetry,
                  maxNumRetry: 8,
                  retryDelayMs: 1000,
                  maxRetryDelayMs: 8000
                }
              }
            }
          : undefined;
        const hlsConfig = {
          ...(options.loader ? { loader: options.loader } : {}),
          ...(fragLoadPolicy ? { fragLoadPolicy } : {}),
          // Forward buffer cushion to ride out transient production/delivery
          // dips. Keep maxBufferLength under the proxy's look-ahead window
          // (MAX_LOOKAHEAD_SEGMENTS × segment duration ≈ 32 s): requesting
          // further ahead than the encoder has produced is treated as a seek
          // and restarts ffmpeg, so we must not over-buffer past that window.
          maxBufferLength: 30,
          maxMaxBufferLength: 60,
          backBufferLength: 30
        };
        const instance = new HlsClass(hlsConfig);
        hlsInstance = instance;
        // Set once the manifest is parsed, so post-manifest fatal errors (live
        // playback) are recovered in place, while warm-up fatals still reject
        // the play() promise below (startup error path).
        let manifestReady = false;
        // Recover a fatal, self-healing error instead of letting the stream die
        // terminally and drop the viewer to the loading/error screen. A seek
        // into not-yet-downloaded torrent data surfaces as a fatal network
        // error once the retries above are exhausted; resuming the load makes
        // hls.js re-request and land when the pieces arrive. The mid-playback
        // buffering notice (driven by the <video> stall events in loading.js)
        // covers the wait. Debounced so a persistent error cannot hot-loop.
        let recovering = false;
        const recoverFatal = (data) => {
          if (recovering || !manifestReady) {
            return;
          }
          const type = data?.type;
          if (type !== HlsClass.ErrorTypes.NETWORK_ERROR && type !== HlsClass.ErrorTypes.MEDIA_ERROR) {
            return;
          }
          recovering = true;
          window.setTimeout(() => {
            recovering = false;
            if (hlsInstance !== instance) {
              return; // superseded / cleared
            }
            try {
              if (type === HlsClass.ErrorTypes.MEDIA_ERROR) {
                instance.recoverMediaError();
              } else {
                instance.startLoad(-1);
              }
              console.debug(`[torrent-tv][hls] recovered fatal ${type}`);
            } catch (recoverError) {
              console.warn("[torrent-tv][hls] recovery failed", recoverError);
            }
          }, 1000);
        };

        // When seeking to a non-zero position (seek-restart), instruct HLS.js
        // to begin buffering from that offset instead of from t=0.
        if (typeof options.startPosition === "number" && Number.isFinite(options.startPosition) && options.startPosition > 0) {
          instance.startPosition = options.startPosition;
        }

        await new Promise((resolve, reject) => {
          const timeoutId = window.setTimeout(() => {
            instance.off(HlsClass.Events.MANIFEST_PARSED, onManifestParsed);
            instance.off(HlsClass.Events.ERROR, onError);
            reject(new Error("HLS manifest parsing timed out."));
          }, 10_000);

          const onManifestParsed = () => {
            window.clearTimeout(timeoutId);
            manifestReady = true;
            instance.off(HlsClass.Events.MANIFEST_PARSED, onManifestParsed);
            instance.off(HlsClass.Events.ERROR, onError);
            resolve();
          };
          const onError = (_event, data) => {
            if (!data?.fatal) {
              console.debug("[torrent-tv][hls] non-fatal error", data?.details, data);
              return;
            }
            console.error("[torrent-tv][hls] fatal error", data?.details, data);
            window.clearTimeout(timeoutId);
            instance.off(HlsClass.Events.MANIFEST_PARSED, onManifestParsed);
            instance.off(HlsClass.Events.ERROR, onError);
            const details = typeof data?.details === "string" ? data.details : "unknown";
            reject(new Error(`Fatal HLS error: ${details}`));
          };

          // Register ALL listeners before attachMedia() so we never miss events
          // that HLS.js fires synchronously inside attachMedia() (e.g. MEDIA_ATTACHED
          // fires synchronously in HLS.js v1+, meaning a listener registered after
          // attachMedia() would be called too late and loadSource() would never run).
          instance.on(HlsClass.Events.MEDIA_ATTACHED, () => {
            instance.loadSource(manifestUrl);
          });
          instance.on(HlsClass.Events.ERROR, (_event, data) => {
            const details = typeof data?.details === "string" ? data.details : "unknown";
            // Console only — never surface to the on-screen status. Non-fatal
            // errors (e.g. bufferStalledError while the transcode warms up the
            // first segments) are transient and recover on their own; showing
            // them would cause a visible glitch before playback starts.
            //
            // [evt] TEMPORARY: timestamp + position + hole size so PTS-gap
            // glitches can be correlated with the proxy's per-session branch
            // (A re-encode vs B copy) and exact moment. `data.hole` is the gap
            // size hls.js jumped over (bufferSeekOverHole).
            const t = new Date().toISOString().slice(11, 23);
            const currentTime = typeof videoElement?.currentTime === "number" ? videoElement.currentTime.toFixed(2) : "?";
            const hole = typeof data?.hole === "number" ? ` hole=${data.hole.toFixed(3)}s` : "";
            if (data?.fatal) {
              console.warn(`[torrent-tv][hls] ${t} fatal: ${details} currentTime=${currentTime}${hole}`, data);
              recoverFatal(data);
            } else {
              console.debug(`[torrent-tv][hls] ${t} non-fatal: ${details} currentTime=${currentTime}${hole}`);
            }
          });
          instance.on(HlsClass.Events.MANIFEST_PARSED, onManifestParsed);
          instance.on(HlsClass.Events.ERROR, onError);

          // Attach media last — may synchronously fire MEDIA_ATTACHED in HLS.js v1+.
          instance.attachMedia(videoElement);
        });

        // Do NOT start playback here. hls.js keeps filling the buffer while the
        // element is paused; playback is started when the player view is
        // revealed (PLAYER:SHOW), so audio never plays underneath the loading /
        // pre-buffer screen and the first frame is shown together with sound.
        return;
      }

      if (!isNativeHlsSupported(videoElement)) {
        throw new Error("HLS is not supported by this browser.");
      }

      videoElement.pause();
      videoElement.src = manifestUrl;
      videoElement.load();
      // Playback is started on player reveal (see above) — not here.
    }
  };
}
