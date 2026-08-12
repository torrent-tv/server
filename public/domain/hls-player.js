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
 * Put the element back where it was after a recovery rebuilt its source.
 *
 * The position cannot simply be assigned: at the moment of recovery the media
 * has no duration yet — `readyState` is 0 — and an assignment is discarded. It
 * is applied as soon as the element knows its duration, and only if it has
 * actually landed somewhere else.
 *
 * @param {HTMLVideoElement} videoElement
 * @param {number} seconds
 * @returns {void}
 */
function restorePosition(videoElement, seconds) {
  if (!(videoElement instanceof HTMLVideoElement)) {
    return;
  }
  const apply = () => {
    if (Math.abs(videoElement.currentTime - seconds) > 1) {
      videoElement.currentTime = seconds;
      console.debug(`[torrent-tv][hls] position restored to ${seconds.toFixed(1)}s after recovery`);
    }
  };
  if (videoElement.readyState >= 1) {
    apply();
    return;
  }
  videoElement.addEventListener("loadedmetadata", apply, { once: true });
}

/**
 * Which variant to start on.
 *
 * The height the proxy is already encoding, because an encoder is running for
 * it — every other rung is a separate ffmpeg run and a cold start before the
 * first frame. A height the master does not list should not happen, since the
 * master is built from that very session; the nearest rung is still a better
 * answer than leaving the choice to the player, which with no measured
 * throughput yet picks the lowest one.
 *
 * @param {{ height?: number }[]} levels
 * @param {number | undefined} preferredHeight
 * @returns {number} An index into `levels`, or −1 when there is nothing to pin.
 */
export function chooseStartLevel(levels, preferredHeight) {
  if (!Array.isArray(levels) || levels.length < 2) {
    return -1;
  }
  const wanted = Number(preferredHeight) || 0;
  if (wanted <= 0) {
    // No height was reported — an older proxy, or a response that lost the
    // field. Take the tallest rung rather than an index, because hls.js orders
    // levels from lowest to highest and index 0 would silently start the viewer
    // on the smallest picture the file is offered at.
    return levels.reduce(
      (best, level, index) => (Number(level?.height) > Number(levels[best]?.height) ? index : best),
      0
    );
  }
  return levels.reduce(
    (best, level, index) =>
      Math.abs(Number(level?.height) - wanted) < Math.abs(Number(levels[best]?.height) - wanted)
        ? index
        : best,
    0
  );
}

/**
 * Fix the variant to start on, and with it turn off the player's own bitrate
 * adaptation.
 *
 * Automatic adaptation is not wanted here and never has been: each variant is
 * its own ffmpeg run on the proxy, so a player switching by itself would start
 * encoders on a host that has capacity for one. Assigning `currentLevel` is
 * what disables it — hls.js adapts only while the level is −1.
 *
 * @param {object} instance - The hls.js instance.
 * @param {number | undefined} preferredHeight - The height the proxy is
 *   already encoding.
 * @returns {void}
 */
function pinStartLevel(instance, preferredHeight) {
  const levels = Array.isArray(instance?.levels) ? instance.levels : [];
  const chosen = chooseStartLevel(levels, preferredHeight);
  if (chosen < 0) {
    return -1;
  }
  instance.currentLevel = chosen;
  console.debug(
    `[torrent-tv][hls] pinned level ${chosen} (${levels[chosen]?.height}p) of ` +
    `${levels.map((level) => `${level?.height}p`).join(", ")}`
  );
  return chosen;
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
  // The variant in force — the one pinned at start or last picked by the
  // viewer. Kept here because hls.js's own `currentLevel` answers a different
  // question: it reports the level of the fragment AT THE PLAYHEAD, so for as
  // long as the old rung is still buffered ahead (up to half a minute) it goes
  // on naming the rung the viewer has just left. Read that way, the menu would
  // snap back to the old height right after a switch and refuse to switch back.
  let desiredLevel = -1;

  return {
    /**
     * The quality variants this stream offers, in the player's own order.
     *
     * Empty for a single media playlist — the proxy publishes a master only
     * where the rungs can actually be joined (every one re-encoded, so all cut
     * on the same grid). The menu is built from what the player reports rather
     * than from a list assembled separately, so the two cannot disagree about
     * what is on offer.
     *
     * @returns {{ index: number, height: number, width: number, bitrate: number }[]}
     */
    levels() {
      const levels = Array.isArray(hlsInstance?.levels) ? hlsInstance.levels : [];
      if (levels.length < 2) {
        return [];
      }
      return levels.map((level, index) => ({
        index,
        height: Number(level?.height) || 0,
        width: Number(level?.width) || 0,
        bitrate: Number(level?.bitrate) || 0
      }));
    },
    /**
     * The variant in force, as an index into {@link levels}. −1 when there is
     * no instance or none has been chosen yet.
     *
     * What was CHOSEN, not what is at the playhead — see `desiredLevel` above.
     *
     * @returns {number}
     */
    currentLevel() {
      if (desiredLevel >= 0) {
        return desiredLevel;
      }
      const level = hlsInstance?.currentLevel;
      return typeof level === "number" ? level : -1;
    },
    /**
     * Change quality without interrupting playback.
     *
     * `nextLevel` rather than `currentLevel`: it switches at the next fragment
     * and keeps what is already playing, where `currentLevel` flushes the whole
     * buffer and rebuffers from the current position — which is the visible
     * interruption this whole path exists to remove.
     *
     * @param {number} index
     * @returns {boolean} False when there is nothing to switch.
     */
    switchLevel(index) {
      if (!hlsInstance || !Number.isInteger(index) || index < 0) {
        return false;
      }
      if (!Array.isArray(hlsInstance.levels) || index >= hlsInstance.levels.length) {
        return false;
      }
      hlsInstance.nextLevel = index;
      desiredLevel = index;
      return true;
    },
    /** Destroy any active HLS.js instance and release its resources. */
    clear() {
      if (hlsInstance) {
        hlsInstance.destroy();
        hlsInstance = null;
      }
      desiredLevel = -1;
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
     * @param {{ loader?: HlsLoaderClass, startPosition?: number, preferredHeight?: number, nativeManifestUrl?: string, onLevelSwitched?: (height: number) => void }} [options]
     *   Pass `{ loader: createWebRtcHlsLoader(proxy) }` when segments and
     *   manifests must be fetched through a WebRTC data channel.
     *   `preferredHeight` pins the variant to start on when the manifest is a
     *   master — the height the proxy is ALREADY encoding, so loading the
     *   master costs no second cold start. `nativeManifestUrl` is what the
     *   native fallback plays instead: it adapts on its own, which must not
     *   reach the variants.
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
                  // Widened again alongside the proxy's short segment hold
                  // (SEGMENT_WAIT_MS): the proxy now answers "retry" within
                  // ~2 s instead of holding the request, so a segment that
                  // takes a while to produce is spread over more retries than
                  // before. This budget (with the growing delay below) still
                  // covers well over a minute of production time.
                  maxNumRetry: 12,
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
          backBufferLength: 30,
          // Where to begin buffering. It belongs HERE, in the configuration
          // handed to the constructor: on the instance `startPosition` is a
          // getter, so assigning to it throws in a module's strict mode —
          // `Cannot set property startPosition of #<e> which has only a
          // getter`, which is what a page refresh reported 2026-08-06. The old
          // assignment below the constructor only ever ran on a resume, so it
          // stayed hidden until the address bar started carrying the position
          // on every reload and the throw became the normal case.
          ...(typeof options.startPosition === "number" &&
            Number.isFinite(options.startPosition) &&
            options.startPosition > 0
            ? { startPosition: options.startPosition }
            : {}),
          // Nothing is fetched until we say so. With a master playlist hls.js
          // would otherwise begin on a variant of ITS choosing — with no
          // measured throughput yet that is the lowest rung — and each variant
          // is a separate encoder on the proxy, so the wrong first choice is a
          // cold start the viewer waits through for nothing. The level is
          // pinned on MANIFEST_PARSED and loading starts there.
          autoStartLoad: false
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
          // Where the viewer was, taken NOW — recovering a media error tears the
          // MediaSource down and builds it again, and what comes back starts at
          // the beginning of the playlist unless it is told otherwise. That is
          // the "it jumped back to the start" the field reported on 2026-08-11:
          // the position was never lost by a seek, it was lost by the recovery
          // from an unrelated error a moment earlier.
          const resumeAt = videoElement instanceof HTMLVideoElement && videoElement.currentTime > 0
            ? videoElement.currentTime
            : -1;
          window.setTimeout(() => {
            recovering = false;
            if (hlsInstance !== instance) {
              return; // superseded / cleared
            }
            try {
              if (type === HlsClass.ErrorTypes.MEDIA_ERROR) {
                instance.recoverMediaError();
                if (resumeAt > 0) {
                  // Both halves are needed: the loader is told where to fetch
                  // from, and the element is put back there once it will accept
                  // a position again.
                  instance.startLoad(resumeAt);
                  restorePosition(videoElement, resumeAt);
                }
              } else {
                instance.startLoad(-1);
              }
              console.debug(
                `[torrent-tv][hls] recovered fatal ${type}` +
                (resumeAt > 0 ? `, resuming at ${resumeAt.toFixed(1)}s` : "")
              );
            } catch (recoverError) {
              console.warn("[torrent-tv][hls] recovery failed", recoverError);
            }
          }, 1000);
        };

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
            desiredLevel = pinStartLevel(instance, options.preferredHeight);
            // Deferred to here by `autoStartLoad: false` above, so the first
            // fragment fetched belongs to the variant we chose.
            instance.startLoad(
              typeof options.startPosition === "number" && options.startPosition > 0
                ? options.startPosition
                : -1
            );
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
          // Why a fragment was asked for. The proxy sees only the number, so a
          // request for segment #0 is indistinguishable there from an ordinary
          // one — and the encoder obediently restarts at the top of the film,
          // which is what the viewer sees as the picture jumping to the
          // beginning (reported 2026-08-10). The answer is on this side: what
          // hls.js last did, and where the viewer actually was.
          let lastPlayerEvent = "none";
          for (const name of ["MEDIA_ATTACHED", "MEDIA_DETACHED", "MANIFEST_PARSED",
            "LEVEL_LOADED", "BUFFER_RESET", "BUFFER_FLUSHED", "ERROR"]) {
            const event = HlsClass.Events[name];
            if (event) {
              instance.on(event, () => { lastPlayerEvent = name; });
            }
          }
          instance.on(HlsClass.Events.FRAG_LOADING, (_event, data) => {
            const start = data?.frag?.start;
            const sn = data?.frag?.sn;
            const at = videoElement instanceof HTMLVideoElement ? videoElement.currentTime : null;
            if (typeof start !== "number" || typeof at !== "number") {
              return;
            }
            // A fragment far from where the viewer is standing is either a seek
            // they made or something restarting the stream behind their back.
            // Only the second is a defect, and only this line can tell them
            // apart.
            if (Math.abs(start - at) > 30) {
              console.warn(
                `[evt] frag-far sn=${sn} fragStart=${start.toFixed(1)}s ` +
                `currentTime=${at.toFixed(1)}s seeking=${videoElement.seeking} ` +
                `lastPlayerEvent=${lastPlayerEvent}`
              );
            }
          });

          // The switch has actually happened — the menu says what is playing,
          // not what was asked for. The two differ for as long as the segment
          // the new variant is being produced takes.
          instance.on(HlsClass.Events.LEVEL_SWITCHED, (_event, data) => {
            const level = instance.levels?.[data?.level];
            const height = Number(level?.height) || 0;
            console.debug(`[torrent-tv][hls] level switched to ${height}p (index ${data?.level})`);
            if (typeof options.onLevelSwitched === "function") {
              options.onLevelSwitched(height);
            }
          });
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
              // What actually went wrong, named. Logging the whole `data` put a
              // dump of the segment's bytes into the line, and the forwarded
              // console truncates at 2000 characters — so a `bufferAppendError`
              // on 2026-08-11 arrived with everything except the exception that
              // caused it, and the cause had to be guessed at. These fields are
              // the ones that identify it: the browser's own message, which
              // buffer refused it, and which file.
              console.warn(
                `[torrent-tv][hls] ${t} fatal: ${details} currentTime=${currentTime}${hole} ` +
                `reason=${data?.reason ?? "-"} buffer=${data?.sourceBufferName ?? "-"} ` +
                `level=${data?.level ?? "-"} frag=${data?.frag?.relurl ?? "-"} sn=${data?.frag?.sn ?? "-"} ` +
                `error=${data?.error?.name ?? "-"}: ${data?.error?.message ?? "-"}`
              );
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
      // The single-variant manifest where one was given. The native player does
      // its own bitrate adaptation and there is no way to turn it off from
      // here — and every switch it made would stop one encoder on someone's
      // home machine and cold-start another. So it is never handed a master.
      videoElement.src = typeof options.nativeManifestUrl === "string" && options.nativeManifestUrl
        ? options.nativeManifestUrl
        : manifestUrl;
      videoElement.load();
      // Playback is started on player reveal (see above) — not here.
    }
  };
}
