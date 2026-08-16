/**
 * @file HLS player wrapper.
 *
 * Wraps the global HLS.js instance (loaded via a `<script>` tag) and falls
 * back to native HLS support on Safari.  Accepts an optional custom `loader`
 * class so that manifest and segment fetches can be routed through an
 * alternative transport — e.g. a WebRTC data channel instead of XHR/Fetch.
 */

/** @import { HlsLoaderClass } from './webrtc-hls-loader.js' */

import { bufferedEndSeconds, MAX_BUFFER_HOLE_SECONDS } from "./buffer-metrics.js";

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
     * `nextLevel` rather than `currentLevel`, which is the lesser of two
     * flushes and not the absence of one. Read in the vendored hls.js: setting
     * `nextLevel` calls `nextLevelSwitch()`, which flushes the buffer from
     * about two fragments ahead of the playhead to the end. `currentLevel`
     * flushes from the playhead itself and rebuffers immediately, so this keeps
     * the picture moving where that would not — but everything the viewer had
     * banked beyond the next couple of fragments is gone either way. Measured
     * 2026-08-14: a 64-second cushion became 1.1 s. That is why the caller must
     * not switch to a rung that is not ready.
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
    /**
     * The audio renditions the master offers, when it publishes them as a
     * group. Empty when it does not — an older proxy, or a stream whose audio
     * is muxed into the picture — and the caller then rebuilds the session to
     * change track, as it always has.
     *
     * @returns {{ index: number, name: string, language: string }[]}
     */
    audioTracks() {
      const tracks = Array.isArray(hlsInstance?.audioTracks) ? hlsInstance.audioTracks : [];
      if (tracks.length < 2) {
        // One rendition is not a choice, and switching to the one already
        // playing is a flush for nothing.
        return [];
      }
      return tracks.map((track, index) => ({
        index,
        name: typeof track?.name === "string" ? track.name : "",
        language: typeof track?.lang === "string" ? track.lang : ""
      }));
    },
    /**
     * The rendition in force, as an index into {@link audioTracks}. −1 when
     * there are none.
     *
     * @returns {number}
     */
    currentAudioTrack() {
      const track = hlsInstance?.audioTrack;
      return typeof track === "number" ? track : -1;
    },
    /**
     * Change audio track without rebuilding anything.
     *
     * With the track published as its own rendition, the player fetches the
     * other one and swaps it in; the picture is not touched at all. Rebuilding
     * the session for this — which is what happens without renditions — is a
     * cold start with the picture gone, measured in tens of seconds on a weak
     * host.
     *
     * @param {number} index
     * @returns {boolean} False when there is nothing to switch.
     */
    switchAudioTrack(index) {
      if (!hlsInstance || !Number.isInteger(index) || index < 0) {
        return false;
      }
      if (!Array.isArray(hlsInstance.audioTracks) || index >= hlsInstance.audioTracks.length) {
        return false;
      }
      hlsInstance.audioTrack = index;
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
     * Point the loader at a position and have it fetch from there.
     *
     * The way out of a wedge that only happens while the element is PAUSED, and
     * therefore only during the cold start. hls.js chooses its next fragment
     * from the end of the buffered run holding the load position, and while
     * paused it computes that run with a hole tolerance of zero, whatever
     * `maxBufferHole` says — verified in the vendored source. So a join left by
     * a keyframe cut, a few hundredths of a second wide, makes it choose the
     * fragment it has already appended, find nothing to do, and stop: measured
     * 2026-08-14, two segments delivered and then 39 s of silence while the
     * proxy held two minutes of finished ones, three times across two sessions,
     * costing 45 s each. Told where the media actually ends, it carries on.
     *
     * @param {number} position - Seconds on the timeline.
     * @returns {boolean} False when there is no hls.js instance to steer.
     */
    resumeLoadAt(position) {
      if (!hlsInstance || !Number.isFinite(position) || position < 0) {
        return false;
      }
      hlsInstance.startLoad(position);
      return true;
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
          // What counts as one run of media rather than two. The default 0.1 s
          // is smaller than the joins this proxy produces: a copied video is
          // cut at the container's own keyframes and the cuts do not always
          // land exactly, so the buffer arrives as neighbouring ranges with a
          // gap of a few hundredths to a couple of tenths of a second. hls.js
          // picks its next fragment from the end of the run holding the
          // playhead, so a gap it will not step over stops it loading
          // altogether — measured 2026-08-14: two segments delivered, then
          // nothing requested for 39 s while the proxy held 130 s of finished
          // ones, and the cold start ran out its whole 45 s timeout. The same
          // figure is used on our side of the fence, so both agree.
          maxBufferHole: MAX_BUFFER_HOLE_SECONDS,
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
        // Said once per player.
        let unrecoverableAnnounced = false;
        /**
         * An append refused by an ENDED MediaSource is the end of this player:
         * nothing downstream can mend it, and the viewer is otherwise left with
         * a waiting overlay over a dead element — measured twice in the field
         * (2026-08-14, 2026-08-15), the second time printing "starting now" for
         * three minutes.
         *
         * Announced whether or not the error is fatal. It was written into the
         * fatal branch alone, on the reasoning that hls.js retries the append
         * and escalates when the retries run out. It does not: on 2026-08-15
         * both `bufferAppendingError` and `bufferAppendError` arrived non-fatal,
         * the media was detached, and no fatal error ever came — so the report
         * never fired and the recovery never ran.
         *
         * But a NON-fatal one does not always mean nobody will act. Read from
         * the vendored hls.js (`ErrorController.onErrorOut`): on this exact
         * message it calls `recoverMediaError()` itself, and that path leaves
         * the error non-fatal. Announcing there would replace a picture hls.js
         * was about to restore with an error screen — and, because recovering
         * detaches the media and ends the source, OUR own recovery would set
         * off the announcement a second later and kill what it was mending. So
         * a non-fatal one is announced only where nothing is going to act:
         * hls.js has decided to do nothing, and no recovery of ours is running.
         *
         * The latch is what makes it safe to call from both places: hls.js's
         * own retries produce several of these, and only the first is worth
         * telling anyone about.
         *
         * @param {string} t
         * @param {string} details
         * @param {{ fatal?: boolean, error?: { message?: string }, errorAction?: { action?: number, resolved?: boolean } }} data
         */
        const announceEndedSource = (t, details, data) => {
          if (unrecoverableAnnounced || !/MediaSource readyState: ended/i.test(String(data?.error?.message ?? ""))) {
            return;
          }
          if (data?.fatal !== true) {
            // 0 is hls.js's `NetworkErrorAction.DoNothing`; an absent action is
            // the same thing, since nothing reads it afterwards.
            const willAct = (data?.errorAction?.action ?? 0) !== 0 || recovering;
            if (willAct) {
              console.debug(
                `[torrent-tv][hls] ${t} ended media source, not announced: ` +
                `action=${data?.errorAction?.action ?? "-"} resolved=${data?.errorAction?.resolved ?? "-"} ` +
                `recovering=${recovering}`
              );
              return;
            }
          }
          unrecoverableAnnounced = true;
          console.warn(`[torrent-tv][hls] ${t} unrecoverable: the media source has ended; the player cannot continue`);
          if (typeof options.onUnrecoverable === "function") {
            options.onUnrecoverable(details);
          }
        };
        const recoverFatal = (data) => {
          // Why a recovery did NOT happen, said out loud. Without it a player
          // left at `currentTime=0 readyState=0` is indistinguishable from one
          // whose recovery ran and lost the position — the two need opposite
          // fixes, and on 2026-08-14 the log could not tell them apart.
          if (recovering || !manifestReady) {
            console.warn(
              `[torrent-tv][hls] recovery declined for ${data?.details ?? "?"}: ` +
              `${recovering ? "already recovering" : "manifest not ready"}`
            );
            return;
          }
          const type = data?.type;
          if (type !== HlsClass.ErrorTypes.NETWORK_ERROR && type !== HlsClass.ErrorTypes.MEDIA_ERROR) {
            console.warn(`[torrent-tv][hls] recovery declined for ${data?.details ?? "?"}: type=${type ?? "-"}`);
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
          // What the start-up actually got through. A manifest that times out
          // says only that nothing arrived; these say WHERE it stopped — and on
          // 2026-08-15 that was the one thing nobody could tell: the browser
          // was handed a master playlist, no request for it ever reached the
          // proxy, and the log held nothing between "attaching" and the
          // timeout.
          let reached = "attach requested";
          const noteStage = (stage) => {
            reached = stage;
            console.debug(`[torrent-tv][hls] start-up: ${stage}`);
          };
          // Chrome does not open a MediaSource for a HIDDEN page, and hls.js
          // waits for it to open before it will ask for anything — so a viewer
          // who looks away while a file is loading gets no manifest, no
          // request, and this timeout, while a viewer who watches the screen
          // gets a film. Measured 2026-08-15 in a hidden tab: `sourceopen`
          // never fires, whatever `preload` says (`metadata`, `auto` and `none`
          // all leave the source `closed`).
          //
          // So the clock does not run while nobody is looking. It starts when
          // the page is shown, which is also the first moment the browser will
          // do any of this work.
          let timeoutId = 0;
          const startTimeout = () => {
            instance.off(HlsClass.Events.MANIFEST_PARSED, onManifestParsed);
            instance.off(HlsClass.Events.ERROR, onError);
            const media = videoElement instanceof HTMLVideoElement ? videoElement : null;
            console.warn(
              `[torrent-tv][hls] start-up stopped at "${reached}" — ` +
              `readyState=${media?.readyState ?? "-"} networkState=${media?.networkState ?? "-"} ` +
              `src=${media?.src ? (media.src.startsWith("blob:") ? "blob" : "url") : "none"} ` +
              `error=${media?.error?.code ?? "-"} inDocument=${media ? document.contains(media) : "-"} ` +
              `url=${manifestUrl.slice(manifestUrl.lastIndexOf("/") + 1)}`
            );
            document.removeEventListener("visibilitychange", onVisibilityChange);
            reject(new Error("HLS manifest parsing timed out."));
          };
          const armTimeout = () => {
            window.clearTimeout(timeoutId);
            timeoutId = window.setTimeout(startTimeout, 10_000);
          };
          const onVisibilityChange = () => {
            if (document.hidden) {
              // Nothing can progress now; stop counting against it.
              window.clearTimeout(timeoutId);
              console.debug("[torrent-tv][hls] page hidden — the browser will not open a media source; waiting");
              return;
            }
            console.debug("[torrent-tv][hls] page shown — start-up can proceed");
            armTimeout();
          };
          document.addEventListener("visibilitychange", onVisibilityChange);
          if (!document.hidden) {
            armTimeout();
          } else {
            console.debug("[torrent-tv][hls] start-up begins on a hidden page; the clock waits for it to be shown");
          }

          const onManifestParsed = () => {
            noteStage("manifest parsed");
            window.clearTimeout(timeoutId);
            document.removeEventListener("visibilitychange", onVisibilityChange);
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
            document.removeEventListener("visibilitychange", onVisibilityChange);
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
            //
            // Measured against the END of what is buffered, not against the
            // playhead. Filling the buffer forward is the loader's ordinary
            // work, so a fragment 30 s ahead of the picture is normal whenever
            // 30 s are already held — and comparing with the playhead made this
            // warn on exactly that: ten times in one healthy session on
            // 2026-08-14 (`sn=5 fragStart=45.3s currentTime=13.6s` while the
            // buffer was growing through 58 s). What is anomalous is a fragment
            // past the edge the loader has reached, or behind the playhead.
            const bufferEnd = bufferedEndSeconds(videoElement);
            const distance = start > bufferEnd ? start - bufferEnd : at - start;
            if (distance > 30) {
              console.warn(
                `[evt] frag-far sn=${sn} fragStart=${start.toFixed(1)}s ` +
                `currentTime=${at.toFixed(1)}s bufferEnd=${bufferEnd.toFixed(1)}s ` +
                `seeking=${videoElement.seeking} lastPlayerEvent=${lastPlayerEvent}`
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
            noteStage(`media attached after ${Math.round(performance.now() - attachRequestedAt)}ms`);
            instance.loadSource(manifestUrl);
            noteStage("manifest requested");
          });
          // The two events that end the MediaSource, and nothing else does —
          // read off the vendored hls.js, `endOfStream()` is called on
          // BUFFER_EOS and in `onMediaDetaching`. An ended MediaSource refuses
          // every later append, which is how a quality change on 2026-08-14
          // ended in `bufferAppendError ... MediaSource readyState: ended`, a
          // position reset to 0 and a player that requested nothing for the
          // next minute and a half. Which of the two fired, and when, is the
          // one fact that log did not carry.
          for (const [name, event] of [
            ["media-detaching", HlsClass.Events.MEDIA_DETACHING],
            ["buffer-eos", HlsClass.Events.BUFFER_EOS],
            ["media-detached", HlsClass.Events.MEDIA_DETACHED]
          ]) {
            if (!event) {
              continue;
            }
            instance.on(event, (_evt, data) => {
              const at = videoElement instanceof HTMLVideoElement ? videoElement.currentTime.toFixed(2) : "?";
              const ready = videoElement instanceof HTMLVideoElement ? videoElement.readyState : "?";
              console.warn(
                `[torrent-tv][hls] ${name} currentTime=${at} readyState=${ready} ` +
                `type=${data?.type ?? "-"} transfer=${data?.transferMedia ? "yes" : "no"}`
              );
            });
          }
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
              // An append refused by an ENDED MediaSource is the end of this
              // player. Reported here and from the non-fatal branch alike —
              // `announceEndedSource` holds the rule about which non-fatal ones
              // count, and the latch that keeps it to one message per player.
              announceEndedSource(t, details, data);
              recoverFatal(data);
            } else {
              // A non-fatal error that names an exception gets the same fields
              // as a fatal one. `bufferAppendError` arrives NON-fatal — hls.js
              // retries the append itself — and when its retries run out it
              // tears the media source down without ever raising a fatal error,
              // so `recoverFatal` below never runs and the position is never
              // taken or restored. Measured 2026-08-14: `bufferAppendingError`
              // at 80.96 s, `bufferAppendError` at 0.00, then `readyState=0`
              // and a player that requested nothing for the remaining 2 min
              // 50 s. Which exception the browser threw is the fact that
              // separates the possible causes, and it was not in the log.
              const cause = data?.error
                ? ` reason=${data?.reason ?? "-"} buffer=${data?.sourceBufferName ?? "-"} ` +
                  `frag=${data?.frag?.relurl ?? "-"} sn=${data?.frag?.sn ?? "-"} ` +
                  // What hls.js decided to DO about it, which is what separates
                  // an error it is recovering from one nobody will act on. It
                  // was missing on 2026-08-15, so which of the two killed that
                  // session had to be read out of the library's source.
                  `action=${data?.errorAction?.action ?? "-"} resolved=${data?.errorAction?.resolved ?? "-"} ` +
                  `error=${data.error.name ?? "-"}: ${data.error.message ?? "-"}`
                : "";
              const level = data?.error
                ? console.warn.bind(console)
                : console.debug.bind(console);
              level(`[torrent-tv][hls] ${t} non-fatal: ${details} currentTime=${currentTime}${hole}${cause}`);
              // An append refused by an ENDED MediaSource is the end of this
              // player, and this is where it actually arrives: non-fatal, twice,
              // and never escalated. Measured 2026-08-15 — `bufferAppendingError`
              // at 217.20 s, the media detached, `bufferAppendError` at 0.00,
              // and then three minutes in which the browser requested nothing
              // while the overlay said playback was about to start.
              announceEndedSource(t, details, data);
            }
          });
          instance.on(HlsClass.Events.MANIFEST_PARSED, onManifestParsed);
          instance.on(HlsClass.Events.ERROR, onError);

          // Attach media last — may synchronously fire MEDIA_ATTACHED in HLS.js v1+.
          // The element as it is handed over, and how long the browser then
          // takes to open the media source. Measured 2026-08-15: usually 3-5 ms,
          // once 13.2 s, and the difference is not the page being hidden — a
          // hidden page attached in 5 ms. What the HTML specification does let a
          // browser refuse to load is media that is NOT RENDERED, so the box the
          // element occupies is recorded beside it.
          const attachRequestedAt = performance.now();
          const box = videoElement.getBoundingClientRect();
          const shownAs = window.getComputedStyle(videoElement);
          console.debug(
            `[torrent-tv][hls] attaching media: readyState=${videoElement.readyState} ` +
            `networkState=${videoElement.networkState} hasSrc=${Boolean(videoElement.src)} ` +
            `inDocument=${document.contains(videoElement)} ` +
            `box=${Math.round(box.width)}x${Math.round(box.height)} display=${shownAs.display} ` +
            `visibility=${shownAs.visibility} page=${document.visibilityState}`
          );
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
