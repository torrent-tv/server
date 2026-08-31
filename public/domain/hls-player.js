/**
 * @file HLS player wrapper.
 *
 * Wraps the global HLS.js instance (loaded via a `<script>` tag) and falls
 * back to native HLS support on Safari.  Accepts an optional custom `loader`
 * class so that manifest and segment fetches can be routed through an
 * alternative transport — e.g. a WebRTC data channel instead of XHR/Fetch.
 */

/** @import { HlsLoaderClass } from './webrtc-hls-loader.js' */

import { bufferedAheadSeconds, bufferedBehindSeconds, bufferedEndSeconds, MAX_BUFFER_HOLE_SECONDS } from "./buffer-metrics.js";

/**
 * How often the cushion is read. Ten seconds is the same cadence the link
 * report already uses, so the two readings line up in a log without either
 * having to be interpolated.
 */
const CUSHION_SAMPLE_MS = 10_000;

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
 * The forward buffer ceiling, in seconds: what the proxy says it keeps produced
 * ahead of the viewer.
 *
 * There is nothing to be gained by aiming past it — those seconds do not exist
 * yet — and everything to be gained by reaching it, since a segment already on
 * the proxy's disk is served without a wait and every second of it is a second
 * of interruption the viewer does not see.
 *
 * A proxy that states nothing is an older one, and then the player keeps the
 * ceiling it has always had. The floor below it is never raised from here: it
 * is what the device's own refusal cannot go under.
 *
 * @param {unknown} statedSeconds - `lookaheadSeconds` from the session-create
 *   response.
 * @returns {number}
 */
export function forwardBufferCeilingSeconds(statedSeconds) {
  const stated = Number(statedSeconds);
  if (!Number.isFinite(stated) || stated <= FORWARD_BUFFER_CEILING_WITHOUT_A_PROXY_FIGURE) {
    return FORWARD_BUFFER_CEILING_WITHOUT_A_PROXY_FIGURE;
  }
  return stated;
}

/**
 * The ceiling used when the proxy does not state its look-ahead — the figure
 * this player carried before it was told, kept so an older proxy behaves
 * exactly as it did.
 */
const FORWARD_BUFFER_CEILING_WITHOUT_A_PROXY_FIGURE = 60;

/** How many unasked-for level changes are undone before the wander stands. */
const MAX_PIN_RESTORES = 3;

/**
 * hls.js's own default byte budget, kept as the answer whenever the level's
 * bitrate is not known — the same 60 MB it would have used itself.
 */
const BYTE_BUDGET_WITHOUT_A_STATED_BITRATE = 60 * 1000 * 1000;

/**
 * How many BYTES the forward buffer may hold, so that the SECONDS decide.
 *
 * hls.js takes the larger of `maxBufferLength` and what the byte budget buys at
 * the level's bitrate, then caps that by `maxMaxBufferLength`:
 *
 *   min( max(8 × maxBufferSize / bitrate, maxBufferLength), maxMaxBufferLength )
 *
 * With the default 60 MB the byte term is what usually decides — 60 s at
 * 8 Mbit/s, 30 s at 25 — so the cushion depended on the stream's bitrate
 * through a figure nobody derived. Sized from the level's own declared bitrate
 * it buys exactly the ceiling, and the duration governs at every bitrate.
 *
 * Never below hls.js's own default: on a thin level the ceiling already binds
 * first, and lowering the budget there would take away a cushion the player
 * managed before while gaining nothing.
 *
 * This is the term that decides how much memory a page holds, so it is also
 * where a phone refuses. That refusal is a measurement and hls.js already acts
 * on it — `QuotaExceededError` lowers `maxMaxBufferLength` — which is why the
 * budget is raised here and the floor is left alone.
 *
 * @param {unknown} ceilingSeconds - The forward buffer ceiling, in seconds.
 * @param {unknown} levelBitrate - The level's declared bitrate, in bit/s.
 * @returns {number} Bytes.
 */
export function bufferByteBudget(ceilingSeconds, levelBitrate) {
  const seconds = Number(ceilingSeconds);
  const bitrate = Number(levelBitrate);
  if (!Number.isFinite(seconds) || seconds <= 0 || !Number.isFinite(bitrate) || bitrate <= 0) {
    return BYTE_BUDGET_WITHOUT_A_STATED_BITRATE;
  }
  return Math.max(BYTE_BUDGET_WITHOUT_A_STATED_BITRATE, Math.round((seconds * bitrate) / 8));
}

/**
 * Whether a refusal to buffer deeper is worth testing again, and at what depth.
 *
 * A browser answers `QuotaExceededError` when a SourceBuffer cannot make room,
 * and hls.js reads that as the device's limit and lowers its ceiling for good —
 * `reduceMaxBufferLength` only ever divides, and nothing in hls.js raises it
 * back. But a media element may only free frames the playhead has PASSED, so at
 * the start of a film there is nothing to free and the refusal is certain
 * whatever the device could really hold. Field 2026-08-31: two minutes into a
 * 75-minute episode the ceiling fell 120 s → 73 s, and the remaining 73 minutes
 * were watched with two thirds of the cushion the proxy was holding for them.
 *
 * So the refusal is re-tested, on the condition that the reason for it has
 * changed: there is now at least as much played material behind the playhead as
 * the player wants ahead of it, so eviction has somewhere to take from. Each
 * attempt goes halfway back rather than all the way, a quiet period since the
 * last refusal is required, and the attempts are counted — a device that really
 * is at its limit refuses again, hls.js lowers the ceiling again, and after a
 * few rounds the answer stands.
 *
 * @param {Object} state
 * @param {number} state.ceiling - The ceiling in force now, seconds.
 * @param {number} state.statedCeiling - What the proxy holds ahead, seconds.
 * @param {number} state.behindSeconds - Played media still buffered behind the
 *   playhead — what the browser may evict.
 * @param {number} state.msSinceRefusal - Since the last refusal.
 * @param {number} state.attempts - Re-tries already made this session.
 * @returns {number} The ceiling to try, or zero for "leave it alone".
 */
export function ceilingWorthRetrying({
  ceiling,
  statedCeiling,
  behindSeconds,
  msSinceRefusal,
  attempts
}) {
  const now = Number(ceiling) || 0;
  const stated = Number(statedCeiling) || 0;
  if (now <= 0 || stated <= now + 1) {
    return 0;
  }
  if ((Number(attempts) || 0) >= CEILING_RETRIES_PER_SESSION) {
    return 0;
  }
  if (!(Number(msSinceRefusal) >= CEILING_RETRY_QUIET_MS)) {
    return 0;
  }
  // The condition that made the refusal inevitable: nothing behind the playhead
  // to evict. Ask for as much behind as the player wants ahead.
  if (!(Number(behindSeconds) >= now)) {
    return 0;
  }
  const next = Math.min(stated, Math.round(now + (stated - now) / 2));
  return next > now + 1 ? next : 0;
}

/** How many times a refused depth is tried again before the answer stands. */
const CEILING_RETRIES_PER_SESSION = 3;
/** How long after a refusal the same depth may be tried again. */
const CEILING_RETRY_QUIET_MS = 60_000;

/**
 * How deep hls.js will actually try to buffer, in seconds.
 *
 * Its own arithmetic, reproduced so a reading can state what the player was
 * ASKED for beside what it HELD. Nothing else in the browser knows this figure:
 * the three configuration fields do not answer it on their own, and the whole
 * defect this work exists to remove was a cushion nobody had ever printed.
 *
 * Read from `getMaxBufferLength` in the vendored hls.js 1.6.16.
 *
 * @param {{ maxBufferLength?: number, maxMaxBufferLength?: number, maxBufferSize?: number }} config
 * @param {unknown} levelBitrate - The level's declared bitrate, in bit/s.
 * @returns {number} Seconds.
 */
export function askedForwardBufferSeconds(config, levelBitrate) {
  const floor = Number(config?.maxBufferLength) || 0;
  const ceiling = Number(config?.maxMaxBufferLength) || 0;
  const budget = Number(config?.maxBufferSize) || 0;
  const bitrate = Number(levelBitrate) || 0;
  const fromBytes = bitrate > 0 ? (8 * budget) / bitrate : 0;
  return Math.min(Math.max(fromBytes, floor), ceiling);
}

/**
 * Size the byte budget to the level now playing, so the seconds ceiling is
 * reachable at this level's bitrate.
 *
 * Read from `instance.levels`, which carries what the master playlist declared,
 * and applied to the live config — hls.js reads the config on every decision,
 * so this takes effect from the next fragment.
 *
 * @param {object} instance - The hls.js instance.
 * @param {number} levelIndex
 * @param {number} ceilingSeconds
 * @returns {void}
 */
function sizeByteBudgetForLevel(instance, levelIndex, ceilingSeconds) {
  const level = Array.isArray(instance?.levels) ? instance.levels[levelIndex] : null;
  if (!level || !instance?.config) {
    return;
  }
  // The same field hls.js itself passes to `getMaxBufferLength`.
  const bitrate = Number(level.maxBitrate) || Number(level.bitrate) || 0;
  const budget = bufferByteBudget(ceilingSeconds, bitrate);
  if (budget === instance.config.maxBufferSize) {
    return;
  }
  instance.config.maxBufferSize = budget;
  console.debug(
    `[torrent-tv][hls] buffer budget ${(budget / 1e6).toFixed(0)}MB for ` +
    `${level.height}p at ${(bitrate / 1e6).toFixed(2)}Mbit/s — ${ceilingSeconds}s of cushion`
  );
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
 * What each track's own buffer holds right now, as ranges.
 *
 * The media element's `buffered` is the INTERSECTION of the tracks it is
 * playing, so a hole in the sound alone shows there as a hole with no way to
 * tell which track made it. hls.js keeps the real source buffers per track, and
 * they are what says whether an appended fragment landed.
 *
 * The shape is hls.js's own and is read defensively, because this is a reading
 * and a reading that throws is worse than one that says "unknown":
 * `bufferController.sourceBuffers` is an array of `[name, SourceBuffer]` pairs
 * (hls.js 1.6.16, `sourceBuffers = [[null, null], [null, null]]` filled in as
 * tracks are created) — NOT an object keyed by name, which is what the first
 * version of this assumed. That version read `undefined`, fell through to the
 * media element every time, and would have printed the very intersection this
 * exists to avoid while the changelog claimed otherwise.
 *
 * `SourceBuffer.buffered` throws `InvalidStateError` once the buffer has been
 * detached from its MediaSource, which is exactly the state a dead film is in,
 * so each read stands on its own.
 *
 * @param {object} instance - The hls.js instance.
 * @param {HTMLVideoElement} videoElement
 * @returns {string}
 */
export function describeTrackBuffers(instance, videoElement) {
  const describe = (name, source) => {
    try {
      const buffered = source?.buffered;
      if (!buffered || typeof buffered.length !== "number") {
        return `${name}=unknown`;
      }
      const ranges = [];
      for (let i = 0; i < buffered.length; i += 1) {
        ranges.push(`${buffered.start(i).toFixed(3)}..${buffered.end(i).toFixed(3)}`);
      }
      return `${name}=[${ranges.join(" ")}]`;
    } catch {
      // silent-ok: the failure IS the reading — a buffer that refuses to be
      // read has been detached from its media source, which is the fact this
      // line is being printed to establish, and it is returned as that word.
      return `${name}=detached`;
    }
  };
  const parts = [];
  const pairs = instance?.bufferController?.sourceBuffers;
  if (Array.isArray(pairs)) {
    for (const pair of pairs) {
      if (!Array.isArray(pair) || !pair[0] || !pair[1]) {
        continue;
      }
      parts.push(describe(pair[0], pair[1]));
    }
  }
  if (parts.length === 0) {
    // Named for what it is. The media element's range is the intersection of
    // its tracks, so it answers a different question, and a line that does not
    // say so would be read as the per-track answer it is standing in for.
    parts.push(describe("media-intersection", videoElement));
  }
  return parts.join(" ");
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
  /**
   * The periodic reading of the cushion: what was asked for, what is held, and
   * whether the device has refused the depth. Stopped with the instance.
   *
   * @type {{ timer: ReturnType<typeof setInterval> } | null}
   */
  let cushionSampler = null;
  const stopCushionSampler = () => {
    if (cushionSampler) {
      clearInterval(cushionSampler.timer);
      cushionSampler = null;
    }
  };
  /**
   * Say every ten seconds how deep the buffer was asked to go and how deep it
   * actually went, and say ONCE whenever the device lowers the ceiling.
   *
   * Without this the cushion is unmeasurable from the field: a session that
   * holds 30 s where 120 s were asked for looks exactly like one that holds
   * 120 s, since the only figures anyone ever saw were the configuration's own.
   * The two answers it separates are "the supply could not fill it" and "the
   * device would not hold it", and they have opposite remedies (roadmap
   * item 4).
   *
   * @param {object} instance
   * @param {HTMLVideoElement} media
   * @param {number} askedCeiling - The ceiling this player set.
   * @returns {void}
   */
  const startCushionSampler = (instance, media, askedCeiling) => {
    stopCushionSampler();
    let lastCeilingSaid = askedCeiling;
    let lastRefusalAt = 0;
    let retries = 0;
    const timer = setInterval(() => {
      if (!instance?.config || !(media instanceof HTMLVideoElement)) {
        return;
      }
      // Only while this player is actually driving the element. hls.js drops
      // `media` on detach, and a sampler that does not check it goes on
      // printing `held 0.0s` at a player nobody is watching — measured
      // 2026-08-28, nine minutes of it after the viewer had left, and the whole
      // of an apparent disagreement with the proxy, which was reporting the
      // same buffer as 124.5 s while it still existed. Read from the instance
      // rather than from a lifecycle event: this is the condition the reading
      // is about, and it cannot be missed by a path nobody thought of.
      if (!instance.media) {
        stopCushionSampler();
        return;
      }
      const level = instance.levels?.[instance.currentLevel];
      const bitrate = Number(level?.maxBitrate) || Number(level?.bitrate) || 0;
      const asked = askedForwardBufferSeconds(instance.config, bitrate);
      const held = bufferedAheadSeconds(media);
      const ceiling = Number(instance.config.maxMaxBufferLength) || 0;
      // hls.js answers `QuotaExceededError` by lowering the ceiling
      // (`reduceMaxBufferLength`). That is the device stating a limit — the one
      // measurement of memory available to us — so it is said the moment it
      // happens rather than left inside hls.js's own logger.
      const behind = bufferedBehindSeconds(media);
      if (ceiling < lastCeilingSaid - 0.5) {
        lastRefusalAt = Date.now();
        console.debug(
          `[torrent-tv][cushion] the device refused the depth: ceiling lowered ` +
          `${lastCeilingSaid.toFixed(0)}s → ${ceiling.toFixed(0)}s ` +
          `(${behind.toFixed(0)}s of played media behind the playhead to evict from)`
        );
        lastCeilingSaid = ceiling;
      } else {
        // A refusal taken at the start of a film is about the moment, not the
        // device: nothing had been played, so nothing could be evicted. Once
        // there is material behind the playhead the same depth may well fit,
        // and hls.js will never ask again on its own.
        const retryAt = ceilingWorthRetrying({
          ceiling,
          statedCeiling: askedCeiling,
          behindSeconds: behind,
          msSinceRefusal: lastRefusalAt === 0 ? 0 : Date.now() - lastRefusalAt,
          attempts: retries
        });
        if (retryAt > 0) {
          retries += 1;
          instance.config.maxMaxBufferLength = retryAt;
          lastCeilingSaid = retryAt;
          console.debug(
            `[torrent-tv][cushion] trying the depth again: ceiling ${ceiling.toFixed(0)}s → ` +
            `${retryAt}s of the ${askedCeiling}s the proxy holds — ${behind.toFixed(0)}s behind the ` +
            `playhead is now evictable, attempt ${retries} of ${CEILING_RETRIES_PER_SESSION}`
          );
        }
      }
      console.debug(
        `[torrent-tv][cushion] held ${held.toFixed(1)}s of ${asked.toFixed(1)}s asked ` +
        `(floor ${instance.config.maxBufferLength}s, ceiling ${ceiling.toFixed(0)}s, ` +
        `budget ${(Number(instance.config.maxBufferSize) / 1e6).toFixed(0)}MB, ` +
        `${behind.toFixed(0)}s behind, ` +
        `${level?.height ?? "?"}p at ${(bitrate / 1e6).toFixed(2)}Mbit/s)`
      );
    }, CUSHION_SAMPLE_MS);
    cushionSampler = { timer };
  };
  // The media this player is driving. Kept because two answers need the
  // playhead and have nothing else to read it from — where a switched audio
  // track resumes, and what a reconnect restores to.
  let attachedMedia = null;
  // The variant in force — the one pinned at start or last picked by the
  // viewer. Kept here because hls.js's own `currentLevel` answers a different
  // question: it reports the level of the fragment AT THE PLAYHEAD, so for as
  // long as the old rung is still buffered ahead (up to half a minute) it goes
  // on naming the rung the viewer has just left. Read that way, the menu would
  // snap back to the old height right after a switch and refuse to switch back.
  let desiredLevel = -1;
  /**
   * How many times a level change nobody asked for has been undone.
   *
   * Bounded because hls.js lowers the level to ESCAPE an error: if the error is
   * real, putting the level back re-enters it, and a loop between the two is
   * worse than either. Three attempts distinguish a stray wander from a rung
   * the player genuinely cannot stay on.
   */
  let pinRestores = 0;

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
      // Where the new track resumes is STATED, not left to be guessed. hls.js
      // discards the audio it holds on a switch, and if the player has nothing
      // buffered at that moment — which is precisely when a viewer reaches for
      // the audio menu — its own recovery (`resetStartWhenNotLoaded`) puts the
      // audio loader back at `startPosition`, and for a VOD opened at the top
      // of the film that is **zero**. Measured 2026-08-18 at 3128.7 s into
      // "Sen to Chihiro no Kamikakushi": the switch was answered by a request
      // for `a/14/segment-00000.mp4`, which is an hour behind the run the proxy
      // had just warmed at the playhead, so it 404'd; hls.js then walked every
      // video level looking for a way out, hit a fatal error, and recovered
      // 25 seconds later. The viewer saw a spinner for all of it.
      //
      // `startLoad(position)` gives both loaders the position outright, so the
      // fallback has the playhead to fall back TO. The media is not moved: the
      // position handed over is the one it is already standing on.
      const resumeAt = attachedMedia instanceof HTMLVideoElement && Number.isFinite(attachedMedia.currentTime)
        ? attachedMedia.currentTime
        : -1;
      if (resumeAt > 0) {
        hlsInstance.startLoad(resumeAt);
      }
      return true;
    },
    /** Destroy any active HLS.js instance and release its resources. */
    clear() {
      stopCushionSampler();
      if (hlsInstance) {
        hlsInstance.destroy();
        hlsInstance = null;
      }
      desiredLevel = -1;
      pinRestores = 0;
      attachedMedia = null;
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
        // What the proxy says it keeps produced ahead of the viewer. Both the
        // seconds ceiling and the byte budget are sized from this one figure,
        // so they cannot disagree about how deep the cushion is meant to be.
        const forwardBufferCeiling = forwardBufferCeilingSeconds(options.lookaheadSeconds);
        const hlsConfig = {
          ...(options.loader ? { loader: options.loader } : {}),
          ...(fragLoadPolicy ? { fragLoadPolicy } : {}),
          // Forward buffer cushion to ride out transient production/delivery
          // dips — the only thing that makes an interruption invisible,
          // whatever caused it.
          //
          // The FLOOR: what this player insists on however little the device
          // will give. It is a floor in hls.js's own arithmetic
          // (`getMaxBufferLength` takes the larger of it and what the byte
          // budget buys) and it is also the one figure the device's refusal
          // cannot go under — `QuotaExceededError` lowers the CEILING and stops
          // here. So the cushion is raised through the ceiling, never through
          // this.
          maxBufferLength: 30,
          // The CEILING: what the proxy says it holds ahead of the viewer,
          // because that is the quantity that decides how much there is to
          // take. This used to be a local 60 justified by
          // `MAX_LOOKAHEAD_SEGMENTS × 4 s ≈ 32 s` — the wrong constant: those
          // eight segments bound a request ahead of the ENCODE HEAD, not ahead
          // of the viewer, and hls.js keeps one fragment outstanding per track
          // anyway, so buffer depth cannot push a request past that window. The
          // proxy meanwhile keeps two minutes produced, and three quarters of
          // it was left on the disk (roadmap item 4).
          maxMaxBufferLength: forwardBufferCeiling,
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
        startCushionSampler(instance, videoElement, forwardBufferCeiling);
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
            stopWatchingTasks();
            const media = videoElement instanceof HTMLVideoElement ? videoElement : null;
            console.warn(
              `[torrent-tv][hls] start-up stopped at "${reached}" — ` +
              `readyState=${media?.readyState ?? "-"} networkState=${media?.networkState ?? "-"} ` +
              `src=${media?.src ? (media.src.startsWith("blob:") ? "blob" : "url") : "none"} ` +
              `error=${media?.error?.code ?? "-"} inDocument=${media ? document.contains(media) : "-"} ` +
              `url=${manifestUrl.slice(manifestUrl.lastIndexOf("/") + 1)} ` +
              (canWatchTasks
                ? `mainThreadBusy=${Math.round(blockedMs)}ms longestTask=${Math.round(longestTaskMs)}ms`
                : "mainThreadBusy=unmeasured")
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
            stopWatchingTasks();
            window.clearTimeout(timeoutId);
            document.removeEventListener("visibilitychange", onVisibilityChange);
            manifestReady = true;
            instance.off(HlsClass.Events.MANIFEST_PARSED, onManifestParsed);
            instance.off(HlsClass.Events.ERROR, onError);
            desiredLevel = pinStartLevel(instance, options.preferredHeight);
            // Now that a level is chosen, its declared bitrate says how many
            // bytes the cushion above costs. Before this the byte budget was
            // hls.js's default and truncated the cushion at any bitrate over
            // 8 Mbit/s.
            sizeByteBudgetForLevel(instance, desiredLevel, forwardBufferCeiling);
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
            stopWatchingTasks();
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
          // A fragment fetched again and again while the buffer stands still is
          // a real failure — measured 2026-08-18, two audio segments fetched 737
          // and 736 times in 149 s while the picture never moved. A guard that
          // stopped playback on it shipped in 0.13.8 and was REMOVED in 0.13.12,
          // because it twice killed sessions that were merely stalling: three
          // appends inside 79 ms during an audio-language change, and three
          // inside 68 ms after hls.js nudged the playhead off an empty buffer.
          // Both look identical to the real loop in every quantity the player
          // exposes at that instant — the buffer is not growing, the picture is
          // not moving — and differ only in how long they go on: the real one
          // ran for two and a half minutes. Nothing here measured that, so the
          // guard was deciding on evidence it did not have. Whatever replaces it
          // must be founded on duration, and must be shown against BOTH recorded
          // cases before it is allowed to stop anything.

          // WHO removes media from the buffer, and which stretch.
          //
          // The one reading missing on 2026-08-27, when thirteen fragments that
          // had been delivered were neither in the buffer nor asked for again.
          // Removal is not a fault by itself — the buffer is bounded and has to
          // be — so the question is never "was something removed" but "what,
          // and under which rule". The range answers it without anyone having
          // to guess: a stretch lying entirely more than `backBufferLength`
          // behind the playhead is the ordinary back-buffer trim; a stretch
          // AHEAD of the playhead is not, and is the case that leaves a hole
          // nothing refills.
          if (HlsClass.Events.BUFFER_FLUSHING) {
            instance.on(HlsClass.Events.BUFFER_FLUSHING, (_event, data) => {
              const at = videoElement instanceof HTMLVideoElement ? videoElement.currentTime : null;
              const from = Number(data?.startOffset);
              const to = Number(data?.endOffset);
              const ahead = typeof at === "number" && Number.isFinite(from) && from > at;
              console.warn(
                `[evt] buffer-flushing ${data?.type ?? "all"} ` +
                `${Number.isFinite(from) ? from.toFixed(1) : "?"}..` +
                `${Number.isFinite(to) ? to.toFixed(1) : "?"}s ` +
                `currentTime=${typeof at === "number" ? at.toFixed(1) : "-"} ` +
                `${ahead ? "AHEAD of the playhead" : "behind the playhead"} ` +
                `lastPlayerEvent=${lastPlayerEvent} ` +
                describeTrackBuffers(instance, videoElement)
              );
            });
          }

          // The other way media leaves: the browser refuses the append because
          // the source buffer is full, and hls.js frees space itself. This is
          // the memory bound doing its job, and it has to be told apart from a
          // flush we asked for — the remedy is opposite in each case.
          instance.on(HlsClass.Events.ERROR, (_event, data) => {
            if (data?.details !== "bufferFullError" && data?.details !== "bufferAddCodecError") {
              return;
            }
            const at = videoElement instanceof HTMLVideoElement ? videoElement.currentTime : null;
            console.warn(
              `[evt] buffer-full ${data.details} fatal=${data?.fatal === true} ` +
              `currentTime=${typeof at === "number" ? at.toFixed(1) : "-"} ` +
              describeTrackBuffers(instance, videoElement)
            );
          });

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
              // The buffered ranges belong in this line, not only the end of
              // them. Field case 2026-08-27: the player asked for fragment
              // #812 while its buffer ended 52.4 s earlier, and the thirteen
              // fragments between had been delivered minutes before, ahead of a
              // seek backwards. Whether they were still held and simply not
              // joined, or had been removed and never re-asked for, decides
              // which defect this is — and neither this line nor the proxy's
              // could say, because the only reading that distinguishes them is
              // the list of ranges themselves.
              console.warn(
                `[evt] frag-far sn=${sn} fragStart=${start.toFixed(1)}s ` +
                `currentTime=${at.toFixed(1)}s bufferEnd=${bufferEnd.toFixed(1)}s ` +
                `seeking=${videoElement.seeking} lastPlayerEvent=${lastPlayerEvent} ` +
                describeTrackBuffers(instance, videoElement)
              );
              // Told to the proxy, not only to this console. This is the
              // earliest statement that exists of a stream coming apart — on
              // 2026-08-21 it fired four times over half a minute, naming the
              // gap in seconds each time, while the buffer stood still and the
              // viewer waited; then hls.js gave up and jumped the picture
              // forward. The proxy is the only side that can say whether the
              // segment it produced holds the boundary its number claims, and
              // it was never asked.
              if (typeof options.onFragmentFar === "function" && !videoElement.seeking) {
                try {
                  options.onFragmentFar({
                    sn,
                    // Which stream this fragment belongs to. hls.js loads the
                    // audio rendition through the same event, and the proxy
                    // serves picture and sound from two different sessions
                    // positioned by two different runs — which is precisely how
                    // they come apart — so a report that does not say which one
                    // it is about gets answered about the other.
                    track: typeof data.frag.type === "string" ? data.frag.type : "",
                    fragStartSec: start,
                    bufferEndSec: bufferEnd,
                    currentTimeSec: at
                  });
                } catch {
                  // silent-ok: a report about a stall must not become one.
                }
              }
            }
          });

          // The same fragment asked for a second time is the shape a dead film
          // takes: the bytes arrive, the player finds the range still
          // unbuffered and asks again, for ever. Measured 2026-08-20 on
          // "Minions.and.Monsters.1080p.mkv" — audio segment #521 served 22
          // times in 16 s, an identical 64825 bytes every time, each within
          // 160 ms — and neither side recorded what the player did with them.
          // What settles it is where the fragment says it is against what its
          // OWN track's buffer holds, which is what this prints.
          //
          // Counted on DELIVERY, not on the request. A request is re-issued for
          // reasons that are not faults and are common here: a segment still
          // being produced fails and is retried up to twelve times by design
          // (see `fragLoadPolicy` above, and the reason it is twelve), and a
          // load aborted by a seek or a rung switch is re-issued too. Counting
          // requests would print a dozen lines for one warming segment, in
          // exactly the stretch of log a session is read for. The field case
          // was 22 SUCCESSFUL deliveries of an identical 64825 bytes, so
          // counting what arrived catches it and excludes every retry by
          // construction.
          //
          // Keyed by rung as well as track and number, and forgotten whenever
          // the player flushes: a quality switch fetches the same numbers from
          // another rung, and after a flush re-fetching is the right thing to
          // do. `backBufferLength` makes flushes routine during healthy
          // playback, which does not weaken this — a player that is stuck
          // appends nothing, so it trims nothing.
          const fragmentDeliveries = new Map();
          instance.on(HlsClass.Events.BUFFER_FLUSHED, () => {
            fragmentDeliveries.clear();
          });
          instance.on(HlsClass.Events.FRAG_LOADED, (_event, data) => {
            const frag = data?.frag;
            const sn = frag?.sn;
            if (typeof sn !== "number") {
              return;
            }
            const key = `${frag?.type ?? "-"}#${frag?.level ?? "-"}#${sn}`;
            const deliveries = (fragmentDeliveries.get(key) ?? 0) + 1;
            fragmentDeliveries.set(key, deliveries);
            if (deliveries < 2) {
              return;
            }
            const start = Number(frag?.start);
            const end = start + Number(frag?.duration);
            const at = videoElement instanceof HTMLVideoElement ? videoElement.currentTime : null;
            console.warn(
              `[evt] frag-again ${key} delivered=${deliveries} ` +
              `frag=${Number.isFinite(start) ? start.toFixed(3) : "?"}..` +
              `${Number.isFinite(end) ? end.toFixed(3) : "?"} ` +
              `currentTime=${typeof at === "number" ? at.toFixed(3) : "-"} ` +
              describeTrackBuffers(instance, videoElement)
            );
          });

          // The switch has actually happened — the menu says what is playing,
          // not what was asked for. The two differ for as long as the segment
          // the new variant is being produced takes.
          instance.on(HlsClass.Events.LEVEL_SWITCHED, (_event, data) => {
            const level = instance.levels?.[data?.level];
            const height = Number(level?.height) || 0;
            console.debug(`[torrent-tv][hls] level switched to ${height}p (index ${data?.level})`);
            // A level nobody here asked for is hls.js moving itself, and it does
            // that despite the pin. `hls.currentLevel = N` sets
            // `manualLevelIndex` and the `nextLoadLevel` GETTER honours it — but
            // the error controller assigns `hls.nextLoadLevel`, and that SETTER
            // writes the level unconditionally, consulting `manualLevelIndex`
            // only to decide whether to touch `nextAutoLevel` as well. So one
            // fragment error steps the viewer down a rung.
            //
            // What that costs here is not a slightly softer picture: a rung
            // below a COPIED source is a full re-encode on somebody's home
            // machine. Field 2026-08-31 — one `fragLoadError` moved a viewer off
            // a 1038p copy running at 3.22x onto an encode that ran at 0.71x for
            // the next fifty minutes, and the picture stood still 161 times.
            //
            // Put back, with a bound: hls.js lowers the level to escape an
            // error, so if the error is real this fights it, and a fight is
            // worse than either outcome. After MAX_PIN_RESTORES the wander
            // stands and the line says so.
            if (desiredLevel >= 0 && data?.level !== desiredLevel) {
              if (pinRestores < MAX_PIN_RESTORES) {
                pinRestores += 1;
                console.warn(
                  `[torrent-tv][hls] level moved to ${height}p (index ${data?.level}) without being asked — ` +
                  `putting it back to index ${desiredLevel}, attempt ${pinRestores} of ${MAX_PIN_RESTORES}`
                );
                instance.currentLevel = desiredLevel;
                return;
              }
              console.warn(
                `[torrent-tv][hls] level moved to ${height}p (index ${data?.level}) without being asked, ` +
                `and it has been put back ${MAX_PIN_RESTORES} times already — letting it stand`
              );
              desiredLevel = data?.level;
            }
            // Another rung is another bitrate, so the cushion costs a different
            // number of bytes to hold.
            sizeByteBudgetForLevel(instance, data?.level, forwardBufferCeiling);
            if (typeof options.onLevelSwitched === "function") {
              options.onLevelSwitched(height);
            }
          });
          instance.on(HlsClass.Events.MEDIA_ATTACHED, () => {
            const attachTookMs = Math.round(performance.now() - attachRequestedAt);
            stopWatchingTasks();
            noteStage(
              `media attached after ${attachTookMs}ms` +
              (attachTookMs > 1000
                ? (canWatchTasks
                  ? ` — the main thread was busy ${Math.round(blockedMs)}ms of it, longest task ${Math.round(longestTaskMs)}ms`
                  : " — this browser does not report long tasks, so what the main thread was doing is unmeasured")
                : "")
            );
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
          // What the MAIN THREAD was doing while the browser was supposed to be
          // opening the media source. Attaching is announced on this thread, so
          // a long task holds the announcement in the queue behind it — and
          // that is the only candidate left for the 13.2 s attach measured on
          // 2026-08-15 against 3-5 ms in every other session on the same build.
          // Nothing in Chromium's documented behaviour defers a MediaSource:
          // the one documented deferral is `loading="lazy"`, which this element
          // does not use, and a hidden page attached in 5 ms in the field.
          let longestTaskMs = 0;
          let blockedMs = 0;
          let taskObserver = null;
          // Whether this browser can answer the question at all. `observe()`
          // does NOT throw for an entry type it does not know — it quietly
          // observes nothing — so without this check Safari and Firefox would
          // report "the main thread was idle" when the truth is "not measured".
          const canWatchTasks = typeof PerformanceObserver === "function" &&
            Array.isArray(PerformanceObserver.supportedEntryTypes) &&
            PerformanceObserver.supportedEntryTypes.includes("longtask");
          try {
            taskObserver = canWatchTasks ? new PerformanceObserver((list) => {
              for (const entry of list.getEntries()) {
                longestTaskMs = Math.max(longestTaskMs, entry.duration);
                blockedMs += entry.duration;
              }
            }) : null;
            taskObserver?.observe({ entryTypes: ["longtask"] });
          } catch (error) {
            console.debug("[torrent-tv][hls] main-thread task reporting is unavailable here", error);
            taskObserver = null; // the rest of the start-up still reports
          }
          const stopWatchingTasks = () => {
            try {
              // The entries still queued are collected FIRST. `disconnect()`
              // drops whatever has not been delivered yet, and a long task that
              // ended just before the attach was announced — precisely the one
              // this is looking for — is the likeliest to be sitting in that
              // queue.
              for (const entry of taskObserver?.takeRecords() ?? []) {
                longestTaskMs = Math.max(longestTaskMs, entry.duration);
                blockedMs += entry.duration;
              }
              taskObserver?.disconnect();
            } catch (error) {
              console.debug("[torrent-tv][hls] task observer was already gone", error);
            }
            taskObserver = null;
          };
          const box = videoElement.getBoundingClientRect();
          const shownAs = window.getComputedStyle(videoElement);
          console.debug(
            `[torrent-tv][hls] attaching media: readyState=${videoElement.readyState} ` +
            `networkState=${videoElement.networkState} hasSrc=${Boolean(videoElement.src)} ` +
            `inDocument=${document.contains(videoElement)} ` +
            `box=${Math.round(box.width)}x${Math.round(box.height)} display=${shownAs.display} ` +
            `visibility=${shownAs.visibility} page=${document.visibilityState}`
          );
          attachedMedia = videoElement;
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
