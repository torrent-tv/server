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
 * Start playback, tolerating the browser's autoplay policy.
 *
 * On iOS (and Chrome without sufficient media engagement) `play()` is rejected
 * with `NotAllowedError` when called outside a user gesture. That is not a
 * playback failure: the stream is ready and the user can start it from the
 * native controls. Swallow only that case and rethrow any real error — this
 * mirrors how the direct/webseed paths handle `play()` in torrent-session.js.
 *
 * @param {HTMLVideoElement} videoElement
 * @returns {Promise<void>}
 */
async function startPlaybackToleratingAutoplayBlock(videoElement) {
  try {
    await videoElement.play();
  } catch (error) {
    if (error instanceof DOMException && error.name === "NotAllowedError") {
      return;
    }
    throw error;
  }
}

/**
 * Create a stateful HLS player instance.
 *
 * @param {(message: string) => void} onLog - Called with status/error messages
 *   emitted by the HLS.js event handler.
 * @returns {{ clear: () => void, play: (videoElement: HTMLVideoElement, manifestUrl: string, options?: { loader?: HlsLoaderClass }) => Promise<void> }}
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
        const hlsConfig = {
          ...(options.loader ? { loader: options.loader } : {}),
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
            if (data?.fatal) {
              console.warn(`[torrent-tv][hls] fatal: ${details}`, data);
            } else {
              console.debug(`[torrent-tv][hls] non-fatal: ${details}`);
            }
          });
          instance.on(HlsClass.Events.MANIFEST_PARSED, onManifestParsed);
          instance.on(HlsClass.Events.ERROR, onError);

          // Attach media last — may synchronously fire MEDIA_ATTACHED in HLS.js v1+.
          instance.attachMedia(videoElement);
        });

        await startPlaybackToleratingAutoplayBlock(videoElement);
        return;
      }

      if (!isNativeHlsSupported(videoElement)) {
        throw new Error("HLS is not supported by this browser.");
      }

      videoElement.pause();
      videoElement.src = manifestUrl;
      videoElement.load();
      await startPlaybackToleratingAutoplayBlock(videoElement);
    }
  };
}
