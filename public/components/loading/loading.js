import { createHlsPlayer } from "../../domain/hls-player.js";
import { APP_EVENT, APP_STATE, } from "../../domain/app-state.js";
import { StateDerivedView } from "../state-derived-view.js";
import { consumeOurPause, pauseWithoutIntent } from "../../domain/playback-intent.js";
import { PROXY_EVENTS, WAITING_EVENTS } from "../../shared/events.js";
import { StageTimeline } from "../../domain/stage-timeline.js";
import { getDebugState } from "../../shared/debug-state.js";
import { TorrentSession } from "../../domain/torrent-session.js";
import { ProxySelector } from "../proxy-selector/proxy-selector.js";
import { ProxyTransport } from "../../domain/proxy-transport.js";
import { createWebRtcHlsLoader } from "../../domain/webrtc-hls-loader.js";
import { queryLocalNetworkPermission, probeLocalNetwork } from "../../domain/local-network-permission.js";
import { APP_EVENTS, ERROR_EVENTS, LOADING_EVENTS, PLAYER_EVENTS, SESSION_EVENTS, signalApp } from "../../shared/events.js";
import {
  readUrlState,
  buildUrlSearch,
  decideHistoryWrite,
  isAdvanceToNext,
  decideNavigation,
  resumePositionFor
} from "../../domain/url-state.js";
import { classifyMediaFiles, normalizeRemoteFileList } from "../../domain/torrent-parser.js";
import { WaitingModel } from "../../domain/waiting-model.js";
import { bufferedAheadSeconds } from "../../domain/buffer-metrics.js";

/** Embedded-subtitle extraction reads the file to the last cue — allow long. */
const EMBEDDED_SUBTITLE_TIMEOUT_MS = 10 * 60_000;

/** A cold magnet needs swarm metadata before the file list exists. */
const MAGNET_METADATA_TIMEOUT_MS = 180_000;

// Auto-reconnect after a mid-playback connection loss (see the auto-reconnect
// OpenSpec change). Attempts 1..2 retry the SAME proxy (seamless swap under
// the live player); attempt 3 falls back to a full re-selection + rebuild.
const RECONNECT_SAME_PROXY_ATTEMPTS = 2;
const RECONNECT_TOTAL_ATTEMPTS = 3;
const RECONNECT_CONNECT_TIMEOUT_MS = 10_000;
const RECONNECT_BACKOFF_MS = 2_000; // pause before attempt 2
const RECONNECT_ONLINE_WAIT_MS = 15_000; // max wait for `online` per attempt
const RECONNECT_STABLE_RESET_MS = 30_000; // healthy playback resets the cycle count
const RECONNECT_MAX_CYCLES = 3; // consecutive loss→recover cycles before giving up

/** Common ISO 639-2 (ffmpeg language tags) → 639-1 codes for `srclang`. */
const ISO639_2_TO_1 = {
  eng: "en", rus: "ru", jpn: "ja", kor: "ko", spa: "es", pol: "pl",
  deu: "de", ger: "de", fra: "fr", fre: "fr", ita: "it", por: "pt",
  ukr: "uk", zho: "zh", chi: "zh", ara: "ar", hin: "hi", tur: "tr",
  nld: "nl", dut: "nl", swe: "sv", ces: "cs", cze: "cs"
};

const LANGUAGE_DISPLAY =
  typeof Intl !== "undefined" && "DisplayNames" in Intl
    ? new Intl.DisplayNames(["en"], { type: "language" })
    : null;

/**
 * @param {string} language - ffmpeg language tag (usually ISO 639-2).
 * @returns {string} Two-letter code when known, the tag otherwise.
 */
function trackLanguageCode(language) {
  const lang = typeof language === "string" ? language.toLowerCase() : "";
  if (lang.length === 2) {
    return lang;
  }
  return ISO639_2_TO_1[lang] ?? lang;
}

/**
 * Human label for a probe track: "English — Commentary", "Track 2", …
 *
 * @param {{ index: number, language?: string, title?: string }} track
 * @returns {string}
 */
function buildTrackLabel(track) {
  const parts = [];
  const code = trackLanguageCode(track.language ?? "");
  if (code) {
    try {
      parts.push(LANGUAGE_DISPLAY?.of(code) ?? code);
    } catch {
      parts.push(code);
    }
  }
  if (typeof track.title === "string" && track.title.trim().length > 0) {
    parts.push(track.title.trim());
  }
  if (parts.length === 0) {
    parts.push(`Track ${Number(track.index) + 1}`);
  }
  return parts.join(" — ");
}
import {
  detectSubtitleInfo,
  buildSubtitleLabel,
  matchSubtitlesForVideo
} from "../../domain/subtitle-utils.js";

/**
 * Loading view.
 *
 * Responsibilities:
 * - Show progress/status while processing torrent playback pipeline.
 * - Execute playback preparation pipeline on `LOADING:PROCESS_PLAYBACK`.
 * - Hide itself when player or error views are shown.
 */
export class Loading extends StateDerivedView {
  static SELECTOR = {
    actionButton: "#loading__action",
    // The overlay's own text line — the one the seek case already used. There
    // is one waiting interface, so there is one place its words go.
  };

  static MESSAGES = {
    missingDomNodes: "Loading component DOM nodes are missing.",
    readingTorrentFile: (fileName) => fileName,
    readingMetadata: "Reading torrent metadata...",
    selectingProxy: "Selecting proxy...",
    connectingToProxy: "Connecting to proxy...",
    fetchingMetadata: "Fetching file metadata...",
    checkingCompatibility: "Checking playback compatibility...",
    preparingHls: "Preparing HLS transcode...",
    preparingHlsAudio: "Audio codec requires transcode. Preparing HLS...",
    preparingHlsVideo: "Video codec requires transcode. Preparing HLS...",
    startingDirectPlayback: "Starting direct playback...",
    probingDirectPlayback: "Verifying direct playback before transcoding...",
    noVideoFile: "No video file found in this torrent.",
    noProxyAndNoWebseed: "No proxy is available and this torrent has no webseed video source.",
    alreadyProcessing: "Already processing another .torrent file.",
    selectedFileNotFound: "Selected video file was not found in torrent metadata.",
    selectedFileUnsupported: "Selected video file format is not supported by the browser.",
    fallingBackToTranscode: "Direct playback unsupported. Falling back to on-the-fly transcode...",
    fallingBackToVideoTranscode: "Video track unsupported. Falling back to on-the-fly video transcode...",
    playerNotReady: "Player is not ready.",
    startingTorrentProcessing: "Starting torrent processing...",
    switchingToSelectedFile: "Starting selected video...",
    chooseVideoFile: "Choose a video file from playlist.",
    headerDownloadStalled:
      "Torrent isn't downloading — no peers reachable for this file. Try again later or pick another source.",
    // Shown INSTEAD of failing once the ordinary wait has been exhausted. There
    // is nothing wrong on our side and nothing to retry: the file simply has
    // nobody to download it from, and that can change at any moment or never.
    // Saying so and waiting on is more useful than an error screen, and the
    // Cancel and Playlist buttons are there for a viewer who would rather not.
    noPeersKeepWaiting:
      "No one is sharing this file yet. Downloading cannot start until someone does — this may take a while, or may not happen at all. You can wait, pick another video, or cancel.",
    connectionLost: "Connection to the proxy was lost.",
    reconnecting: "Reconnecting...",
    waitingForNetwork: "Waiting for the network to come back…",
    switchingAudio: "Switching audio track...",
    switchingQuality: "Switching quality...",
    // Says what was observed and nothing else. It used to name the local
    // network as the cause, and on 2026-08-09 it did so while ICE was complete
    // over global IPv6, the send queue was empty and progress polls were being
    // answered in 9-43 ms — the one thing known to be in order. The real fault
    // was on the proxy, and this message cost real time on the way to finding
    // it. A message must not name a cause it has not established.
    prebufferStalled: "Could not start playback: the proxy accepted the request but sent no video. Nothing here says why — the proxy's own log will.",
    lanPermissionExplainer:
      "The video source is a device on your own network. Your browser asks for permission before a website may talk to it — press Allow and confirm the browser's question.",
    lanPermissionWaiting: "Waiting for the browser's local network permission...",
    lanPermissionDenied:
      "Local network access is blocked for this site, so the video source on your network cannot be reached. Enable \"Local network\" in the browser's site settings (the icon next to the address), then press Check again.",
    lanAllowButton: "Allow",
    lanCheckAgainButton: "Check again",
    fetchingMagnetMetadata: "Fetching torrent metadata from the swarm...",
    magnetMetadataFailed:
      "Could not fetch metadata for this magnet link — no peers reachable. Try again later."
  };

  // How long to wait for the file header quietly before SAYING that nothing is
  // arriving (cold torrent / peers connecting). It used to be the point at which
  // the load failed, which was wrong: a torrent with no seeders is not a fault
  // to report, it is a fact to state — nothing is broken, nothing would be fixed
  // by retrying, and someone may start sharing a minute later. Past this point
  // the wait continues with an honest message; the viewer leaves by cancelling
  // or by picking another video.
  static PLAN_WAIT_MS = 180_000;

  // How far back the download-rate trend is measured. Long enough to see the
  // climb (the swarm takes 6-8 s to reach its plateau), short enough that a
  // rate which has since levelled off stops being projected upward.
  static RATE_TREND_WINDOW_MS = 6_000;
  // The projection may not claim an average faster than this multiple of the
  // rate being achieved right now, however steep the samples look.
  static RATE_TREND_MAX_GROWTH = 4;

  /**
   * Recent download-speed samples, for projecting a rate that is still rising.
   * See #projectDownloadEta.
   *
   * @type {Array<{ at: number, speed: number }>}
   */
  #downloadRateSamples = [];
  /** The last figure shown, and when — so the countdown can only go down. */
  #etaPromise = null;
  /**
   * Whether this file has ever actually played. Distinguishes the first open —
   * where OUR prebuffer gate decides when the player is revealed — from a
   * later wait, where the player resumes by itself as soon as it has anything.
   * `#isProcessing` was used for this and is not the same thing: it is still
   * false for the first ticks of a cold open, which took those ticks down the
   * resume path and showed a 2 s target where 15 s was going to be enforced.
   */
  #hasPlayedOnce = false;
  #etaPromiseAt = 0;
  /**
   * What the chosen proxy takes to produce a session's first segment, from the
   * playback plan. Seconds, or null before it has told us.
   */
  #expectedFirstSegmentSeconds = null;
  /** What the chosen proxy takes to create a session, in seconds, or null. */
  #expectedSessionCreateSeconds = null;
  /**
   * How much buffer this player actually had when it started, the last few
   * times. Measured at every `playing` event, because how much is enough is a
   * property of the player and the device, not something we may pick: it was
   * 0.5 s after one seek, 2.0 s after another and 20.0 s on a cold open.
   *
   * @type {number[]}
   */
  #playbackStartBuffers = [];
  /** When the address bar last received the playback position. */
  #urlPositionWrittenAt = 0;
  /** A rebuild after the proxy lost the session is in flight. */
  #rebuildingSession = false;
  /** A Back/Forward navigation is being carried out; see #onHistoryNavigate. */
  #navigatingHistory = false;
  /** The loading screen stepped aside for the playlist drawer. */
  #playlistOpenedFromLoading = false;
  /** The "nobody is sharing this" notice has been shown for this attempt. */
  #longWaitAnnounced = false;
  #actionButton;
  #videoElement = null;
  #session;
  #proxySelector;
  #hlsPlayer;
  #isProcessing = false;
  #diagnosticsAttached = false;
  #directPlaybackUnsupportedCache = new Set();
  #directPlaybackHints = new Map();
  /** @type {import("../../domain/webrtc-proxy.js").WebRtcProxy | null} */
  #proxy = null;
  /** @type {import("../../domain/proxy-transport.js").ProxyTransport | null} */
  #transport = null;
  /** @type {Array<object>} All subtitle files parsed from the current torrent. */
  #subtitleFiles = [];
  /** @type {string[]} Blob URLs created for active subtitle tracks; revoked on cleanup. */
  #subtitleBlobUrls = [];
  /** @type {number} Index of the file currently playing (-1 = none). */
  #activeFileIndex = -1;
  /**
   * Snapshot taken at the moment the proxy connection was lost, consumed by
   * the Retry action. Captured BEFORE the error flow runs, because the error
   * screen's #stopPlayback() clears `session.current`.
   *
   * @type {{ fileIndex: number, positionSeconds: number, sessionCurrent: object } | null}
   */
  #resumeState = null;
  /**
   * Descriptor of the last successfully connected proxy, so the auto-reconnect
   * flow can rebuild the SAME connection (same candidate policy → no permission
   * question on the same-proxy path). Refreshed by #adoptProxy on every
   * successful connect.
   *
   * @type {{ proxyId: string, proxyLocalPort: number | null, allowPrivateCandidates: boolean } | null}
   */
  #lastProxyDescriptor = null;
  /**
   * Count of consecutive loss→recover cycles. Reset to 0 after playback
   * survives {@link RECONNECT_STABLE_RESET_MS}. Guards against an endless
   * reconnect loop when playback keeps dying immediately after recovery.
   *
   * @type {number}
   */
  #reconnectCycles = 0;
  /** @type {ReturnType<typeof setTimeout> | null} Pending cycle-count reset timer. */
  #stableTimer = null;
  /**
   * Cooperative cancellation for the in-flight loading flow. Checked at the
   * await boundaries via #throwIfCancelled(); the thrown AbortError rides the
   * existing silent abort-error handling, which also guarantees a cancelled
   * flow can never reach its PLAYBACK_READY dispatch.
   *
   * @type {boolean}
   */
  #cancelRequested = false;
  /**
   * Monotonic id of the current playback attempt. Bumped when a new attempt
   * starts and when the flow is cancelled, so a late failure from a superseded
   * or cancelled attempt (e.g. a data-channel request that rejects after the
   * user moved on) is recognised as stale and never shows the error screen over
   * whatever is playing now. See #failPlayback.
   *
   * @type {number}
   */
  #playbackEpoch = 0;
  /** @type {number} Viewer-chosen audio track (type-relative; 0 = default). */
  #selectedAudioTrackIndex = 0;
  /**
   * Track inventory from the playback plan of the active file.
   * @type {{ audio: Array<object>, subtitles: Array<object> } | null}
   */
  #planTracks = null;
  /** @type {number} Viewer-forced output height (0 = Auto / realtime budget). */
  #selectedQualityHeight = 0;
  /**
   * @type {number} Which quality pick is the current one. Warming a rung waits
   * on the proxy, so picks made close together finish in the order the rungs
   * happen to be ready — not the order they were made.
   */
  #qualityPickSeq = 0;
  /**
   * The height automatic quality is producing right now, as reported by the
   * proxy. Zero when unknown or when the video is copied — then nothing is
   * being chosen and the source's own height is what plays.
   */
  #autoEffectiveHeight = 0;
  /** Whether the current stream's video is re-encoded rather than copied. */
  #videoIsReencoded = false;
  /** @type {number} Source coded width/height from the proxy plan (0 = unknown / not proxy-served). */
  #sourceVideoWidth = 0;
  #sourceVideoHeight = 0;
  /**
   * Cold-start phase marks (performance.now()) for the proxy-served flow, used
   * to log one summary line on a successful start. Set at the top of the
   * proxy branch of #switchToVideoFile; cleared when the summary is logged.
   *
   * @type {{ t0: number, t1?: number, t2?: number, t3?: number } | null}
   */
  #coldStart = null;
  /**
   * True once the player view is revealed and playback is live, so buffer-empty
   * events are treated as mid-playback data starvation (buffering notice) rather
   * than the normal pre-buffer fill. Cleared when loading/error/stop take over.
   *
   * @type {boolean}
   */
  #playbackLive = false;

  /** Pending seek-intent report timer (see #reportSeekIntent). */
  #seekReportTimer = null;
  /** @type {ReturnType<typeof setTimeout> | null} Debounce before showing the buffering notice. */
  #bufferingTimer = null;
  /** @type {boolean} Whether the mid-playback buffering notice is currently shown. */
  #bufferingShown = false;
  /** @type {ReturnType<typeof setInterval> | null} Periodic stats poll while buffering (peers/speed/amount-left). */
  #bufferingPollTimer = null;
  /**
   * Trailing samples of `{ at, ahead }` used to measure how fast the browser's
   * buffer is actually filling — the basis of the playback ETA. See
   * #trackBufferFillRate.
   *
   * @type {{ at: number, ahead: number }[]}
   */
  #bufferFillSamples = [];
  /**
   * Most recent torrent stats (peers / speed / bytes still needed), kept so
   * every surface that answers "how long until I can watch" can show the
   * supply stage — not just the one that happens to be polling right now.
   * Null until the first poll lands.
   *
   * @type {{ numPeers?: number, downloadSpeed?: number, resumeNeededBytes?: number | null, resumeDownloadedBytes?: number | null } | null}
   */
  #lastDownloadStats = null;
  /**
   * Bumped on every #showBuffering() call (a fresh buffering episode) and on
   * #clearBuffering(). A re-entrant #showBuffering() (e.g. a seek-settle
   * debounce firing, then a `stalled` event re-arming its own debounce before
   * the first one's poll() has resolved — both real events from the SAME
   * scrub, observed field-side ~3s apart) starts a SECOND overlapping poll()
   * with no ordering guarantee against the first; whichever network response
   * lands last wins the DOM write regardless of which was actually more
   * recent. Each poll() captures the epoch at its own #showBuffering() call
   * and only writes to the DOM while it is still current, so a slow, stale
   * response can never overwrite a fresher one — this is what "the percent
   * looked frozen" traced back to (field-reported 2026-08-01).
   *
   * @type {number}
   */
  #bufferingEpoch = 0;
  /**
   * Byte offset the resume window is pinned to for the CURRENT buffering
   * episode. Captured from the proxy's first poll response and sent back on
   * every subsequent poll of the SAME episode, so the proxy computes "bytes
   * needed" against a fixed target instead of the live read position — which
   * slides forward as playback/encoding progresses and would otherwise make
   * the number jump up mid-poll. Null = no episode in progress / not yet
   * captured. Reset at the start of each new episode (#showBuffering) and
   * cleared when it ends (#clearBuffering).
   * @type {number | null}
   */
  #bufferingResumeAnchorByteStart = null;
  /**
   * Playback position (seconds) from a shared `&currentTime=` link, applied once
   * the player is revealed and the media is seekable, then cleared. Named to
   * match `video.currentTime` — the same name across every layer. Null = none.
   * @type {number | null}
   */
  #pendingCurrentTime = null;
  /**
   * The position a resume asked for, held until playback actually begins so the
   * two can be compared. Null when this start is not a resume.
   *
   * @type {number | null}
   */
  #resumeAskedFor = null;
  /**
   * File index from a shared `&fileIndex=` link — which file of a multi-file
   * torrent to open — consumed when the source's file list is known. Null = none.
   * @type {number | null}
   */
  #pendingFileIndex = null;

  /** @param {CustomEvent} event */
  #onShow = (event) => {
    const payload = event instanceof CustomEvent ? event.detail : null;
    this.#logEvt(`loading content set cause=LOADING:SHOW`);
    // Content and pipeline state only — whether this view is on screen follows
    // from the application state (`#onAppStateChanged`). This event now means
    // "a build is starting", which is what the machine reads it as.
    // The loading view is back in front — playback is no longer live; drop any
    // mid-playback buffering notice so it cannot leak onto the next state.
    this.#playbackLive = false;
    this.#clearBuffering();
    // Cleared with it: otherwise the next stream's first stall compares against
    // the last stream's answer and is never reported to the machine.
    this.#bufferingSignalled = false;
    if (typeof payload?.fileName === "string") {
      this.setFileName(payload.fileName);
    }
    if (typeof payload?.status === "string") {
      this.setStatus(payload.status);
    }
    if (typeof payload?.progress === "number") {
      this.setProgress(payload.progress);
    }
  };

  /** @param {CustomEvent} event */
  #onSetFileName = (event) => {
    const payload = event instanceof CustomEvent ? event.detail : null;
    this.setFileName(typeof payload?.value === "string" ? payload.value : "");
  };

  /** @param {CustomEvent} event */
  #onSetStatus = (event) => {
    const payload = event instanceof CustomEvent ? event.detail : null;
    this.setStatus(typeof payload?.value === "string" ? payload.value : "");
  };

  /** @param {CustomEvent} event */
  #onSetProgress = (event) => {
    const payload = event instanceof CustomEvent ? event.detail : null;
    const value = typeof payload?.value === "number" ? payload.value : 0;
    this.setProgress(value);
  };

  /** @param {CustomEvent} event */
  #onProcessPlayback = (event) => {
    const payload = event instanceof CustomEvent ? event.detail : null;
    const epoch = this.#beginPlaybackAttempt();
    void this.#processPlayback(payload).catch((error) => {
      if (this.#isAbortError(error)) {
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      console.error("[torrent-tv] playback failed:", message, error);
      this.#failPlayback(epoch, { description: message, canRetry: error?.canRetry === true });
    });
  };

  /** @param {CustomEvent} event */
  #onPlayerReady = (event) => {
    const payload = event instanceof CustomEvent ? event.detail : null;
    const videoElement = payload?.videoElement;
    if (videoElement instanceof HTMLVideoElement) {
      this.#videoElement = videoElement;
      this.#attachPlaybackDiagnostics(videoElement);
    }
  };

  /**
   * [evt] TEMPORARY: timestamped playback diagnostics (seek/stall/play) for
   * correlating the browser timeline with the proxy's segment/restart logs.
   *
   * @param {HTMLVideoElement} videoElement
   * @returns {void}
   */
  #attachPlaybackDiagnostics(videoElement) {
    if (this.#diagnosticsAttached) {
      return;
    }
    this.#diagnosticsAttached = true;
    const log = (name) => {
      // UTC HH:MM:SS.mmm — same timezone as the proxy logger, so browser and
      // proxy logs line up exactly when correlating them.
      const t = new Date().toISOString().slice(11, 23);
      console.debug(
        `[evt] ${t} ${name} currentTime=${videoElement.currentTime.toFixed(1)} ` +
          `bufferedAhead=${bufferedAheadSeconds(videoElement).toFixed(1)}s`
      );
    };
    for (const name of ["seeking", "seeked", "waiting", "playing", "pause", "ended", "stalled", "error"]) {
      videoElement.addEventListener(name, () => {
        log(name);
        this.#onPlaybackEventForBuffering(name);
        // The viewer stopping or restarting playback is a state of the
        // application, not merely of the element. Mirrored, never decided here:
        // the element owns the fact and this reports it.
        if (name === "pause") {
          // A pause we caused ourselves is not a decision by the viewer.
          if (!consumeOurPause(videoElement)) {
            this.#viewerPaused = true;
            signalApp(APP_EVENT.PAUSED_BY_VIEWER, { viewerWantsPlayback: false });
          }
        } else if (name === "playing") {
          this.#viewerPaused = false;
          signalApp(APP_EVENT.RESUMED, { viewerWantsPlayback: true });
        }
        this.#reportSeekIntent(name, videoElement);
        // The moments where the position has definitely changed and settled.
        if (name === "seeked" || name === "pause" || name === "playing") {
          this.#reflectStateInUrl();
        }
      });
    }
    // While playing, the position moves continuously and the address bar has to
    // follow it, or a bookmark taken mid-film reopens at the last discrete
    // event. `timeupdate` fires about four times a second, which is far too
    // often to write history — Safari begins throttling around a hundred calls
    // in thirty seconds — so it is written at most once every
    // URL_POSITION_INTERVAL_MS. At that rate it is six calls per thirty
    // seconds, an order of magnitude under any browser's limit, and cheap
    // enough on a phone.
    videoElement.addEventListener("timeupdate", () => {
      const now = Date.now();
      if (now - this.#urlPositionWrittenAt < URL_POSITION_INTERVAL_MS) {
        return;
      }
      this.#urlPositionWrittenAt = now;
      this.#reflectStateInUrl();
    });
    // Leaving, or being sent to the background, is the last chance to record
    // where the viewer got to. `pagehide` and `visibilitychange` are the pair
    // that fire reliably on iOS, where `beforeunload` is ignored.
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") {
        this.#reflectStateInUrl();
      }
    });
    window.addEventListener("pagehide", () => this.#reflectStateInUrl());
    document.addEventListener(SESSION_EVENTS.GONE, () => { void this.#rebuildGoneSession(); });
    document.addEventListener(SESSION_EVENTS.PROGRESS, (event) => {
      const detail = event instanceof CustomEvent ? event.detail : null;
      this.#noteHostTimings(detail);
      this.#noteEffectiveQuality(detail);
    });
    // Leaving for the picker has to reach the address bar too. Nothing else
    // does it: every other write is driven by an event of the <video> element,
    // and by this point there is no longer anything playing.
    // Leaving for the picker is the one moment the address is cleared: the
    // viewer said so. Every other path that finds no source — a failure, a
    // teardown — leaves the address alone, because it is what Retry and a
    // reload read the position from.
    document.addEventListener(APP_EVENTS.RESET_TO_PICKER, () => {
      if (location.search.length > 0) {
        this.#writeHistory("push", { magnet: "", fileIndex: -1, currentTime: 0 });
      }
    });
    window.addEventListener("popstate", () => { void this.#onHistoryNavigate(); });
    // Periodic bottleneck classification while playing. Distinguishes, from
    // client-visible symptoms, whether playback is limited by the client's own
    // decode (dropped frames while the buffer holds) or by something upstream
    // (buffer draining — proxy CPU / proxy download / delivery, split later by
    // the budget using the proxy's own speed/download signals). Logged as
    // [bottleneck]; the client logger forwards it to the server log for field
    // analysis.
    let prevAhead = bufferedAheadSeconds(videoElement);
    let prevDropped = 0;
    let prevTotal = 0;
    window.setInterval(() => {
      if (videoElement.paused || videoElement.ended || videoElement.readyState < 2) {
        return;
      }
      const t = new Date().toISOString().slice(11, 23);
      const ahead = bufferedAheadSeconds(videoElement);
      const aheadDelta = ahead - prevAhead;
      prevAhead = ahead;

      // Dropped-frame ratio over this window (decode can't keep up).
      let droppedRatio = 0;
      let windowFrames = 0;
      let windowDropped = 0;
      if (typeof videoElement.getVideoPlaybackQuality === "function") {
        const q = videoElement.getVideoPlaybackQuality();
        windowFrames = Math.max(0, q.totalVideoFrames - prevTotal);
        windowDropped = Math.max(0, q.droppedVideoFrames - prevDropped);
        prevTotal = q.totalVideoFrames;
        prevDropped = q.droppedVideoFrames;
        droppedRatio = windowFrames > 0 ? windowDropped / windowFrames : 0;
      }

      // Classify. Buffer draining toward empty = upstream-limited; heavy frame
      // drops with a held buffer = client decode-limited.
      const draining = aheadDelta < -1 && ahead < 8;
      const decodeStruggling = droppedRatio > 0.05 && windowFrames > 10;
      let bottleneck;
      if (decodeStruggling && draining) {
        bottleneck = "client-decode+upstream";
      } else if (decodeStruggling) {
        bottleneck = "client-decode";
      } else if (draining) {
        bottleneck = "upstream"; // proxy CPU / download / delivery — split by the budget
      } else {
        bottleneck = "ok";
      }
      console.debug(
        `[bottleneck] ${t} ${bottleneck} bufferedAhead=${ahead.toFixed(1)}s ` +
          `delta=${aheadDelta.toFixed(1)}s dropped=${windowDropped}/${windowFrames} ` +
          `(${(droppedRatio * 100).toFixed(1)}%)`
      );
    }, 10_000);
  }

  /**
   * Tell the proxy where the viewer seeked, so it can move the encoder there.
   *
   * Debounced on `seeking`: a scrub emits a continuous stream of `seeking`
   * events (one per pointer move — a single drag produced dozens, measured),
   * and only the position it settles on matters. `SEEK_REPORT_DEBOUNCE_MS`
   * after the last one, that position is sent.
   *
   * This is the sole source of seek intent. The proxy cannot infer it: one seek
   * leaves ~25 concurrent segment requests outstanding across a wide span, so
   * any rule over them picks noise (field 2026-08-02: nine encoder restarts in
   * a minute, ~70 s to complete one seek).
   *
   * @param {string} name - The <video> event name.
   * @param {HTMLVideoElement} videoElement
   * @returns {void}
   */
  #reportSeekIntent(name, videoElement) {
    if (name !== "seeking") {
      return;
    }
    if (this.#seekReportTimer !== null) {
      clearTimeout(this.#seekReportTimer);
    }
    this.#seekReportTimer = window.setTimeout(() => {
      this.#seekReportTimer = null;
      const position = videoElement.currentTime;
      if (!Number.isFinite(position)) {
        return;
      }
      this.#logEvt(`seek intent → ${position.toFixed(1)}s`);
      // A new destination is a new wait: the countdown for the old one no
      // longer describes anything, so it may start over from a larger number.
      this.#waitingModel.reset();
      void this.#session.reportSeek(position);
    }, SEEK_REPORT_DEBOUNCE_MS);
  }

  /**
   * Map a raw <video> event to the mid-playback buffering notice. A stall or a
   * seek (`waiting`/`stalled`/`seeking`) schedules the notice after a short
   * debounce; a resume or a stop (`playing`/`seeked`/`pause`/`ended`/`error`)
   * clears it. `seeking` is included so a seek into not-yet-downloaded data
   * shows the spinner even while paused (scrubbing on a paused player).
   *
   * @param {string} name
   * @returns {void}
   */
  #onPlaybackEventForBuffering(name) {
    if (name === "waiting" || name === "stalled" || name === "seeking") {
      this.#scheduleBufferingCheck();
      return;
    }
    // `seeked` = the seek genuinely completed (data arrived); terminal states
    // always clear.
    if (name === "seeked" || name === "ended" || name === "error") {
      this.#clearBuffering();
      return;
    }
    // A pause/resume toggled WHILE a seek is still pending must NOT hide the
    // spinner — the target data has not arrived yet (start seek → pause → play →
    // pause with the seek unfinished keeps it visible). Clear only when no seek
    // is in progress.
    if (name === "playing") {
      // Where a resume ASKED to start against where it actually started. The
      // two are not the same and the difference was invisible: reported
      // 2026-08-06 as "about five seconds earlier than where I stopped", of
      // which the address's two-second write interval and its rounding down
      // explain three, and nothing in the log accounted for the rest. Written
      // once per resume, on the edge, and only when a position was asked for.
      if (this.#resumeAskedFor !== null) {
        const startedAt = this.#videoElement instanceof HTMLVideoElement
          ? this.#videoElement.currentTime
          : 0;
        this.#logEvt(
          `resume asked for ${this.#resumeAskedFor.toFixed(2)}s, playback began at ` +
          `${startedAt.toFixed(2)}s (${(startedAt - this.#resumeAskedFor).toFixed(2)}s)`
        );
        this.#resumeAskedFor = null;
      }
      // What this player needed before it moved. The estimate's last term
      // counts toward this, so it is observed rather than chosen.
      const aheadAtStart = this.#videoElement instanceof HTMLVideoElement
        ? bufferedAheadSeconds(this.#videoElement)
        : null;
      if (typeof aheadAtStart === "number" && aheadAtStart > 0) {
        this.#playbackStartBuffers.push(aheadAtStart);
        if (this.#playbackStartBuffers.length > PLAYBACK_START_SAMPLES) {
          this.#playbackStartBuffers.shift();
        }
      }
      // From here on the player gates its own resumes; our prebuffer cushion
      // applies only to the first reveal. Cleared with the rest of the
      // per-attempt state in #beginPlaybackAttempt.
      this.#hasPlayedOnce = true;
    }
    if (name === "playing" || name === "pause") {
      const video = this.#videoElement;
      if (!(video instanceof HTMLVideoElement) || !video.seeking) {
        this.#clearBuffering();
      }
    }
  }

  /**
   * After a short debounce, show the buffering notice only if playback is still
   * genuinely starved — lacking enough buffered data to proceed. A paused player
   * is NOT excluded (a paused seek into not-yet-downloaded data must show the
   * spinner); an ended/errored one is. The debounce keeps a normal sub-second
   * wait or an instant in-buffer seek from flashing the notice.
   *
   * @returns {void}
   */
  #scheduleBufferingCheck() {
    if (!this.#playbackLive || this.#bufferingTimer !== null) {
      return;
    }
    this.#bufferingTimer = window.setTimeout(() => {
      this.#bufferingTimer = null;
      const video = this.#videoElement;
      if (!(video instanceof HTMLVideoElement) || video.ended || video.error) {
        return;
      }
      // Show when a seek is STILL in progress after the debounce — the target
      // data has not arrived. `video.seeking` (true from `seeking` until
      // `seeked`) is reliable across browsers INCLUDING iOS native HLS, where
      // `readyState` can stay optimistically high during a paused scrub, so the
      // readyState check alone missed the iPhone non-fullscreen paused-seek case.
      // Otherwise fall back to genuine buffer starvation (readyState below
      // HAVE_FUTURE_DATA).
      if (video.seeking || video.readyState < 3) {
        void this.#showBuffering();
      }
    }, 250);
  }

  /**
   * Show the spinner immediately, then add the live peer count below it so a
   * stalled viewer sees the torrent is still downloading (few peers) rather
   * than a frozen player.
   *
   * @returns {Promise<void>}
   */
  async #showBuffering() {
    const epoch = ++this.#bufferingEpoch;
    this.#bufferingShown = true;
    this.#bufferingResumeAnchorByteStart = null; // fresh episode — re-pin on the first poll
    this.#dispatchBuffering(true, ""); // spinner only until the first stats arrive
    // Poll live stats while buffering. Two DISTINCT stages, shown one at a time:
    // while there is no active transcode session yet, show download progress
    // (peers/speed/bytes-left); once a transcode session exists for the file
    // (the download-phase byte target has effectively been met and encoding has
    // started), show ITS progress instead — a downloaded-bytes count is no
    // longer the meaningful number once ffmpeg is actively producing segments.
    // Stopped by #clearBuffering. Guarded by `epoch` (see #bufferingEpoch) so a
    // re-entrant #showBuffering() call's poll can never have its DOM write
    // clobbered by a slower, now-stale response from an earlier one.
    const poll = async () => {
      const [downloadStats, transcodeProgress] = await Promise.all([
        this.#fetchBufferingStats(),
        this.#session.fetchActiveTranscodeProgress()
      ]);
      if (downloadStats) {
        this.#lastDownloadStats = downloadStats;
      }
      this.#noteEffectiveQuality(transcodeProgress);
      // Publish what the proxy said, exactly as it said it. Who needs a figure
      // out of this works it out for themselves — the overlay from its own
      // model, this component from its own. Handing round conclusions is how
      // one of them came to be told what to display.
      document.dispatchEvent(new CustomEvent(PROXY_EVENTS.MEASURED, {
        detail: { downloadStats, transcodeProgress }
      }));
    };
    await poll();
    if (this.#bufferingShown && epoch === this.#bufferingEpoch && this.#bufferingPollTimer === null) {
      this.#bufferingPollTimer = window.setInterval(() => { void poll(); }, 1500);
    }
  }







  /**
   * How long the bytes still missing will take, given that the swarm is still
   * speeding up.
   *
   * Dividing what is left by the speed RIGHT NOW is only right once the speed
   * has settled. A cold torrent does not start at its final rate — measured
   * 2026-08-04 on one session: 74 KB/s, then 1264, 2635, 3587, 3987 at two
   * second intervals — so an estimate taken during the climb divides by a
   * number the rest of the transfer will never see again. Every measured error
   * was in the same direction, and the largest of them at the moment the viewer
   * is most likely to be looking:
   *
   *   | when            | shown | real |
   *   |-----------------|-------|------|
   *   | 4.7 s to go     |  35 s | 4.7 s|
   *   | 2.5 s to go     | 8.5 s | 2.5 s|
   *   | 6.2 s to go     |  19 s | 6.2 s|
   *
   * So the climb is part of the estimate. With a rate `v` rising at `a` per
   * second, `R` bytes take the `t` that solves `R = v·t + a·t²/2`. On the three
   * cases above this gives 10.4 s, 4.8 s and 6.6 s — the last almost exact, the
   * others still high but no longer wrong by a factor of seven.
   *
   * When the rate has levelled off `a` is zero and this is exactly `R / v`
   * again, so a settled connection is unaffected.
   *
   * @param {number} remainingBytes
   * @param {number} speedNow - Bytes per second, as the proxy reports it.
   * @returns {number} Seconds.
   */

  /**
   * Let the estimate be revised upward again. Called when the thing being
   * waited for CHANGES — a seek, another file, a fresh attempt — because the
   * previous countdown was about something else.
   *
   * @returns {void}
   */






  /**
   * Measured rate at which the browser's buffer is filling, in seconds of media
   * gained per second of wall clock. This is the end-to-end rate of the entire
   * pipeline, so it accounts for every bottleneck at once — including ones the
   * individual stages cannot see (e.g. segments arriving but being rejected).
   *
   * Averaged over a short trailing window rather than taken between two
   * consecutive polls: media arrives in whole segments, so a per-poll delta
   * alternates between a spike and zero and would make the ETA jump around.
   * Returns null until the window covers enough wall time to be meaningful, and
   * while the buffer is not growing — the caller then reports "unknown" instead
   * of inventing a number.
   *
   * @param {number} bufferedAhead - Current seconds buffered ahead.
   * @returns {number | null}
   */
  #trackBufferFillRate(bufferedAhead) {
    const now = Date.now();
    const samples = this.#bufferFillSamples;
    samples.push({ at: now, ahead: bufferedAhead });
    while (samples.length > 0 && now - samples[0].at > BUFFER_FILL_WINDOW_MS) {
      samples.shift();
    }
    if (samples.length < 2) {
      return null;
    }
    const oldest = samples[0];
    const spanMs = now - oldest.at;
    if (spanMs < BUFFER_FILL_MIN_SPAN_MS) {
      return null;
    }
    const gained = bufferedAhead - oldest.ahead;
    if (gained <= 0) {
      return null; // not filling — the honest answer is "unknown", not zero
    }
    // Measured up to the last sample that actually grew, not up to now. The
    // buffer does not fill smoothly: a segment is ~10 s of media and lands at
    // once, so between two arrivals the buffer sits still. Dividing by the time
    // since the oldest sample therefore reports a rate that decays purely
    // because nothing has arrived YET — measured 2026-08-05: a buffer parked at
    // 10.37 s took its rate from 1.235 down to 1.070 over 1.3 s of waiting, and
    // the estimate built on it climbed from 11.9 s to 13.7 s while the real
    // remaining time fell from 1.6 s to 0.25 s. The gap before the next arrival
    // is real, but it is not a slowdown, and the countdown rule
    // (#applyMonotonicEta) is what keeps it from being read as one.
    let lastGrowthAt = now;
    for (let index = samples.length - 1; index > 0; index -= 1) {
      if (samples[index].ahead > samples[index - 1].ahead) {
        lastGrowthAt = samples[index].at;
        break;
      }
    }
    const growthSpanMs = Math.max(BUFFER_FILL_MIN_SPAN_MS, lastGrowthAt - oldest.at);
    return gained / (growthSpanMs / 1000);
  }




  /**
   * Cancel a pending buffering check + the stats poll, and hide the notice if
   * it is showing.
   *
   * @returns {void}
   */
  #clearBuffering() {
    this.#bufferingEpoch += 1; // invalidate any in-flight poll() from this or a prior episode
    if (this.#bufferingTimer !== null) {
      clearTimeout(this.#bufferingTimer);
      this.#bufferingTimer = null;
    }
    if (this.#bufferingPollTimer !== null) {
      clearInterval(this.#bufferingPollTimer);
      this.#bufferingPollTimer = null;
    }
    if (this.#bufferingShown) {
      this.#bufferingShown = false;
      this.#dispatchBuffering(false);
    }
    this.#bufferingResumeAnchorByteStart = null;
  }

  /**
   * @param {boolean} active
   * @param {string} [text] - Pre-formatted pill text (empty until stats arrive).
   * @returns {void}
   */
  #dispatchBuffering(active, text = "") {
    document.dispatchEvent(
      new CustomEvent(PLAYER_EVENTS.SET_BUFFERING, {
        detail: { active, text }
      })
    );
    // The same fact, told to the state machine. This function already decides
    // exactly the predicate STALLED is defined by — a frame is wanted and is
    // not available — so the machine reads it here rather than working it out
    // a second time somewhere else.
    //
    // Only while a stream exists: before that the wait is the cold open, which
    // is OPENING and is already true. And only on a CHANGE, because this is
    // called again on every stats poll just to refresh the pill's text.
    if (!this.#playbackLive || active === this.#bufferingSignalled) {
      return;
    }
    this.#bufferingSignalled = active;
    const video = this.#videoElement;
    signalApp(active ? APP_EVENT.FRAME_BLOCKED : APP_EVENT.FRAME_AVAILABLE, {
      viewerWantsPlayback: video instanceof HTMLVideoElement ? !video.paused : true
    });
  }

  /**
   * Live stats for the active file (peers + download speed). Reuses the cached
   * sourceKey (no re-registration), so it is a single cheap stats fetch.
   * Returns null on any failure — the pill then stays with just the spinner.
   *
   * Pins the resume window to a fixed byte offset for the duration of one
   * buffering episode: sends back `#bufferingResumeAnchorByteStart` once it has
   * been captured from an earlier poll of the SAME episode, so the proxy
   * computes "bytes needed" against a fixed target instead of the live read
   * position (see the field's doc comment).
   *
   * @returns {Promise<{ numPeers: number, downloadSpeed: number } | null>}
   */
  async #fetchBufferingStats() {
    try {
      if (!this.#transport || this.#activeFileIndex < 0) {
        return null;
      }
      const sourceKey = await this.#session.registerSourceOnProxy(this.#transport);
      const anchorParam = this.#bufferingResumeAnchorByteStart !== null
        // Pinned no longer. The anchor freezes the point the window is measured
        // ahead of, which is right for a stable progress denominator and wrong
        // for "how much is still needed before the picture can move": within
        // seconds it describes a stretch already passed. Field 2026-08-09 —
        // "16.0 MB left" stood unchanged across three phases at 4.2 MB/s, a
        // rate that would clear 16 MB in four seconds. Measured against the
        // live read position it answers the question actually being asked.
        ? ""
        : "";
      const response = await this.#transport.fetch(
        `/api/sources/${encodeURIComponent(sourceKey)}/stats?fileIndex=${this.#activeFileIndex}${anchorParam}`,
        { cache: "no-store" }
      );
      if (!response.ok) {
        return null;
      }
      const stats = await response.json();
      // Capture the anchor ONCE per episode (first successful poll) — later
      // polls keep sending that same value above, so we must not overwrite it
      // with a newer live position on every response.
      if (this.#bufferingResumeAnchorByteStart === null && typeof stats?.resumeAnchorByteStart === "number") {
        this.#bufferingResumeAnchorByteStart = stats.resumeAnchorByteStart;
      }
      return {
        numPeers: typeof stats?.numPeers === "number" ? stats.numPeers : 0,
        downloadSpeed: typeof stats?.downloadSpeed === "number" ? stats.downloadSpeed : 0,
        resumeNeededBytes: typeof stats?.resumeNeededBytes === "number" ? stats.resumeNeededBytes : null,
        resumeDownloadedBytes: typeof stats?.resumeDownloadedBytes === "number" ? stats.resumeDownloadedBytes : null
      };
    } catch {
      return null;
    }
  }

  /**
   * The waiting view is on screen exactly while a wanted frame is missing —
   * a cold open or a stall — and off screen otherwise. Derived from the state;
   * see `domain/app-state.js`.
   *
   * @param {string} state
   * @param {boolean} belongsOnScreen
   */
  applyAppState(state, belongsOnScreen) {
    // The picture has actually started. Score every estimate shown during the
    // wait that just ended against what really happened — the only moment at
    // which that comparison is possible.
    if (state === APP_STATE.ADVANCING) {
      this.#waitingModel.reportEtaAccuracy();
    }
    super.applyAppState(state, belongsOnScreen);
    if (state === APP_STATE.ADVANCING && !this.#playbackLive) {
      this.#logEvt("playback is live");
      // Playback is live now — buffer-empty events mean data starvation, not
      // the pre-buffer fill, so the mid-playback buffering notice applies.
      this.#playbackLive = true;
      this.#applyPendingResume();
    }
  }

  /**
   * Seek to the shared-link resume position once, when the player is revealed.
   * Waits for the media to become seekable (duration known — the synthetic VOD
   * playlist provides it) if it is not ready yet. One-shot.
   *
   * @returns {void}
   */
  #applyPendingResume() {
    const currentTime = this.#pendingCurrentTime;
    if (currentTime == null || !(this.#videoElement instanceof HTMLVideoElement)) {
      return;
    }
    this.#pendingCurrentTime = null;
    const video = this.#videoElement;
    const seek = () => {
      if (Number.isFinite(video.duration) && video.duration > 0) {
        try {
          video.currentTime = Math.min(currentTime, video.duration - 1);
          this.#logEvt(`resume seek to ${currentTime}s`);
        } catch {
          // Non-seekable yet / rejected — best effort.
        }
      }
    };
    if (Number.isFinite(video.duration) && video.duration > 0) {
      seek();
    } else {
      video.addEventListener("loadedmetadata", seek, { once: true });
    }
  }

  /** @param {CustomEvent} event */
  #onSelectMediaFile = (event) => {
    const payload = event instanceof CustomEvent ? event.detail : null;
    const fileIndex = Number(payload?.fileIndex);
    if (!Number.isInteger(fileIndex)) {
      return;
    }
    if (!this.#session.current) {
      return;
    }
    if (this.#isProcessing) {
      return;
    }
    // A different file has its own tracks and resolution — reset audio + quality.
    this.#selectedAudioTrackIndex = 0;
    this.#selectedQualityHeight = 0;
    document.dispatchEvent(
      new CustomEvent(LOADING_EVENTS.SHOW, {
        detail: {
          status: Loading.MESSAGES.switchingToSelectedFile,
          progress: 0
        }
      })
    );
    const epoch = this.#beginPlaybackAttempt();
    void this.#switchToVideoFile(fileIndex).catch((error) => {
      if (this.#isAbortError(error)) {
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      console.error("[torrent-tv] playback failed:", message, error);
      this.#failPlayback(epoch, { description: message, canRetry: error?.canRetry === true });
    });
  };

  /** @param {CustomEvent} event */
  #onProcessMagnet = (event) => {
    const magnetUri = event instanceof CustomEvent ? event.detail?.magnetUri : "";
    const currentTime = event instanceof CustomEvent ? (event.detail?.currentTime ?? null) : null;
    const fileIndex = event instanceof CustomEvent ? (event.detail?.fileIndex ?? null) : null;
    const epoch = this.#beginPlaybackAttempt();
    void this.#processMagnetPlayback(magnetUri, currentTime, fileIndex).catch((error) => {
      if (this.#isAbortError(error)) {
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      console.error("[torrent-tv] magnet playback failed:", message, error);
      this.#failPlayback(epoch, { description: message, canRetry: error?.canRetry === true });
    });
  };

  #onErrorShow = () => {
    // For a multi-file torrent keep the parsed source so the error screen's
    // "Back to episodes" → pick another episode re-enters the loading flow;
    // otherwise `session.current` is null and #onSelectMediaFile bails out,
    // leaving an empty player.
    this.#stopPlayback({ keepSource: this.#videoFileCount() > 1 });
  };

  #onPageHide = () => {
    this.#stopPlayback({ preferBeacon: true, reason: "pagehide" });
  };

  #onBeforeUnload = () => {
    this.#stopPlayback({ preferBeacon: true, reason: "beforeunload" });
  };

  /**
   * The last thing said to the machine about whether a frame is missing, so a
   * poll that only refreshes the pill's text does not repeat it.
   *
   * @type {boolean}
   */
  #bufferingSignalled = false;

  /**
   * The one place the figures are worked out. The overlay has its own for what
   * it shows; this one answers the pipeline's own question — whether there is
   * enough buffered to let the picture start. Same class, so the two can never
   * disagree about what "enough" means.
   *
   * @type {WaitingModel}
   */
  #waitingModel = new WaitingModel();

  /**
   * The buffer's fill rate, as measured by the component that owns the element.
   *
   * There are two models — this one decides when the picture may start, the
   * overlay's decides what to show — and only the overlay's was being given
   * this reading. The diagnostic is printed by THIS one, which is why every
   * line of it read `fillRate=n/a` while the buffer was visibly filling to 27
   * seconds. The rate is the one figure that prices the whole chain at once, so
   * the model that gates playback is precisely the one that must not be without
   * it.
   *
   * @type {number | null}
   */
  #lastFillRate = null;

  /**
   * The buffer reading published by the component that owns the element.
   *
   * One reading, so the gate and the overlay cannot answer the same question
   * differently. Measuring it here as well is what let the overlay say the
   * cushion was met while the gate went on waiting.
   *
   * @type {number | null}
   */
  #lastBufferedAhead = null;

  /**
   * Everything the waiting overlay is allowed to say something about, in one
   * object. Two writers used to share that line — the pipeline's stage string
   * and the buffering formatter — so the same wait read one way while opening
   * and another once it stalled, and there was no single place to look to find
   * out why. Measurements accumulate here; the words are made from them in one
   * function, `formatWaitingText`.
   *
   * @type {import("../../domain/waiting-text.js").WaitingMeasurements}
   */
  #waiting = {};

  /**
   * Which tracks the proxy is re-encoding for this session. Copied tracks cost
   * nothing and have no encoder to describe, so a session that copies both
   * contributes no encoder line at all.
   *
   * @type {{ video: boolean, audio: boolean }}
   */
  #encodingTracks = { video: false, audio: false };

  /**
   * Every estimate shown during the current wait, with the moment it was shown.
   *
   * The figure on screen is a prediction, and nothing has ever checked it
   * against what happened. Once the picture starts, each of these can be scored
   * exactly: an estimate made N seconds before playback began should have said
   * N. Kept per wait and reported once, so the log carries the shape of the
   * error — which term is optimistic, and when — rather than a single anecdote.
   *
   * @type {Array<{ atMs: number, predicted: number, terms: string }>}
   */
  #etaSamples = [];

  /**
   * Whether the step now shown was named by the PIPELINE rather than worked out
   * from the measurements. Without it a derived step froze at its first value:
   * it is stored in the same field, so the next poll saw a step already present
   * and left it alone, and "Fetching video data" stayed on screen through the
   * encoding that followed.
   *
   * @type {boolean}
   */
  #stageFromPipeline = false;

  /**
   * The stages of the wait in progress. Every step the viewer is shown opens
   * one, so closing it logs how long that step took and how far that was from
   * what was predicted — for the connect, which used to be a single opaque
   * label over a health poll, an ICE exchange and a liveness check, and for a
   * seek, which used to show a number of seconds with no name at all.
   *
   * @type {StageTimeline}
   */
  #stages = new StageTimeline({ log: (message) => this.#logEvt(message) });

  /**
   * Whether the VIEWER stopped playback — not whether the element is stopped.
   * The two differ wherever we pause on our own account, which is the whole of
   * the pre-buffer gate. See domain/playback-intent.js.
   *
   * @type {boolean}
   */
  #viewerPaused = false;

  /**
   * Whether the viewer wants the picture to move — read from the element, which
   * owns the fact. Sent with a stream that has just become usable so a rebuild
   * finishing under a pause does not start playing at someone who stopped it.
   *
   * @returns {boolean}
   */
  #viewerWantsPlayback() {
    return !this.#viewerPaused;
  }

  #onAppReset = () => {
    this.#stopPlayback();
    this.setProgress(0);
    this.setStatus("");
    this.setFileName("Waiting for a .torrent file...");
    this.#directPlaybackUnsupportedCache.clear();
    this.#activeFileIndex = -1;
    this.#resumeState = null;
  };

  #stopPlayback(options = {}) {
    this.#isProcessing = false;
    this.#playbackLive = false;
    this.#clearBuffering();
    // Cleared with it: otherwise the next stream's first stall compares against
    // the last stream's answer and is never reported to the machine.
    this.#bufferingSignalled = false;
    this.#session.clear({
      preferBeacon: options?.preferBeacon === true,
      reason: typeof options?.reason === "string" ? options.reason : "",
      keepSource: options?.keepSource === true
    });
    this.#hlsPlayer.clear();
    this.#clearSubtitleTracks();
    if (this.#proxy) {
      this.#proxy.close();
      this.#proxy = null;
      this.#transport = null;
    }
    if (this.#videoElement instanceof HTMLVideoElement) {
      this.#videoElement.pause();
      this.#videoElement.removeAttribute("src");
      this.#videoElement.load();
    }
  };

  constructor() {
    // OPENING only, NOT `isWaiting`. This view is a MODAL dialog: shown for a
    // stall it covers the video and the whole control bar, and being modal it
    // makes them inert, so a viewer who seeks into missing data cannot pause,
    // scrub back or play until the data arrives. A stall is answered by the
    // small overlay inside the player instead. Collapsing the two waiting
    // interfaces into one is roadmap item 8; until then they stay separate and
    // this one keeps the job it can do without trapping anyone.
    super((state) => state === APP_STATE.OPENING);
    this.#actionButton = document.querySelector(Loading.SELECTOR.actionButton);

    if (!this.#actionButton) {
      throw new Error(Loading.MESSAGES.missingDomNodes);
    }

    this.#session = new TorrentSession(() => undefined);
    this.#proxySelector = new ProxySelector();
    this.#hlsPlayer = createHlsPlayer((message) => {
      console.debug("[torrent-tv][hls]", message);
      this.setStatus(message);
    });
    this.#loadDirectPlaybackHints();
    this.#setupEventHandlers();
    document.dispatchEvent(new CustomEvent(PLAYER_EVENTS.REQUEST_READY));
  }

  #setupEventHandlers() {
    document.addEventListener(LOADING_EVENTS.SHOW, this.#onShow);
    document.addEventListener(LOADING_EVENTS.SET_FILE_NAME, this.#onSetFileName);
    document.addEventListener(LOADING_EVENTS.SET_STATUS, this.#onSetStatus);
    document.addEventListener(LOADING_EVENTS.SET_PROGRESS, this.#onSetProgress);
    document.addEventListener(LOADING_EVENTS.PROCESS_PLAYBACK, this.#onProcessPlayback);
    document.addEventListener(LOADING_EVENTS.PROCESS_MAGNET, this.#onProcessMagnet);
    document.addEventListener(PLAYER_EVENTS.SELECT_MEDIA_FILE, this.#onSelectMediaFile);
    document.addEventListener(PLAYER_EVENTS.SELECT_AUDIO_TRACK, this.#onSelectAudioTrack);
    document.addEventListener(PLAYER_EVENTS.SELECT_QUALITY, this.#onSelectQuality);
    document.addEventListener(APP_EVENTS.RETRY_PLAYBACK, this.#onRetryPlayback);
    document.addEventListener(PLAYER_EVENTS.READY, this.#onPlayerReady);
    document.addEventListener(ERROR_EVENTS.SHOW, this.#onErrorShow);
    document.addEventListener(APP_EVENTS.RESET_TO_PICKER, this.#onAppReset);
    document.addEventListener(PLAYER_EVENTS.BUFFER, (event) => {
      const rate = event instanceof CustomEvent ? event.detail?.fillRate : null;
      this.#lastFillRate = typeof rate === "number" && Number.isFinite(rate) ? rate : null;
      // The SAME reading the overlay's model is given. The gate used to measure
      // the element itself, so one rule ran on two different numbers taken at
      // two different moments — and they disagreed exactly where it shows: the
      // overlay announced the cushion 100% met and zero seconds left while the
      // gate held playback, which is the `[ready] said=0.0 was=42.6` case in the
      // accuracy report and what the viewer sees as "0 seconds" over a picture
      // that never starts.
      const ahead = event instanceof CustomEvent ? event.detail?.bufferedAhead : null;
      this.#lastBufferedAhead = typeof ahead === "number" && Number.isFinite(ahead) ? ahead : null;
    });
    window.addEventListener("pagehide", this.#onPageHide);
    window.addEventListener("beforeunload", this.#onBeforeUnload);
    document.addEventListener(PLAYER_EVENTS.CLOSE_PLAYLIST, this.#onPlaylistClosed);
  }

  /**
   * Throw a silent AbortError when the user cancelled the in-flight flow.
   * Called at the await boundaries of the loading pipeline.
   */
  #throwIfCancelled() {
    if (!this.#cancelRequested) {
      return;
    }
    const error = new Error("Loading cancelled by the user.");
    error.name = "AbortError";
    throw error;
  }

  /**
   * Mark the start of a new playback attempt and return its epoch. The caller
   * passes this epoch to #failPlayback so a failure that arrives after the
   * attempt was superseded/cancelled is ignored.
   *
   * @returns {number}
   */
  #beginPlaybackAttempt() {
    this.#playbackEpoch += 1;
    // Per attempt: a new file, or the same one tried again, starts with the
    // ordinary wait rather than the notice left over from the last one.
    this.#longWaitAnnounced = false;
    this.#hasPlayedOnce = false;
    // The previous attempt's rate history says nothing about this one.
    this.#downloadRateSamples = [];
    this.#waitingModel.reset();
    return this.#playbackEpoch;
  }

  /**
   * Surface a playback failure — but only if `epoch` is still the current
   * attempt. A late rejection from a superseded or cancelled attempt is logged
   * and dropped, so it never replaces live playback with the error screen.
   *
   * @param {number} epoch
   * @param {{ description: string, canRetry?: boolean }} detail
   * @returns {void}
   */
  #failPlayback(epoch, detail) {
    if (epoch !== this.#playbackEpoch) {
      this.#logEvt(`stale playback failure ignored (epoch ${epoch}≠${this.#playbackEpoch}): ${detail?.description ?? ""}`);
      return;
    }
    document.dispatchEvent(new CustomEvent(LOADING_EVENTS.PLAYBACK_FAILED, { detail }));
  }

  /**
   * User-initiated cancel of the loading flow. Tears the attempt down
   * (pending requests, transcode session, player state) but KEEPS
   * `session.current` and the transport, so a multi-file torrent returns to
   * a usable playlist and the next selection reuses the open data channel.
   */
  /**
   * Open the playlist without abandoning the load.
   *
   * A load can take a long time for reasons the viewer cannot influence — a
   * torrent with no seeders is the honest example — and until now the only way
   * out was Cancel, which throws away the whole session and returns to the
   * picker. Switching to another episode is usually what the viewer actually
   * wants, and it needs neither of those things: the playlist's own selection
   * handler supersedes the attempt in flight.
   *
   * @returns {void}
   */
  #onPlaylistClick = () => {
    this.#logEvt("playlist opened from the loading screen");
    // This dialog is modal, so nothing outside it can be clicked while it is
    // open. It steps aside for the drawer and comes back if the drawer is
    // closed without a choice being made — and if a choice IS made, the new
    // attempt shows it again itself.
    this.#playlistOpenedFromLoading = true;
    this.visible = false;
    document.dispatchEvent(new CustomEvent(PLAYER_EVENTS.OPEN_PLAYLIST));
  };

  /**
   * The playlist drawer closed. If it was opened from here and the load is
   * still the one that opened it, take the screen back.
   *
   * @returns {void}
   */
  #onPlaylistClosed = () => {
    if (!this.#playlistOpenedFromLoading) {
      return;
    }
    this.#playlistOpenedFromLoading = false;
    if (this.#isProcessing) {
      this.visible = true;
    }
  };

  /**
   * Show or hide the way out of a long load. Only worth offering when there is
   * somewhere else to go.
   *
   * @param {boolean} visible
   * @returns {void}
   */
  #setPlaylistButtonVisible(visible) {
    // The player's own playlist button is on screen throughout, so the waiting
    // interface does not carry a second one.
  }

  #onCancelClick = () => {
    this.#logEvt("loading cancelled by user");
    this.#cancelRequested = true;
    // Supersede the current attempt so its now-aborted requests, when they
    // reject, are recognised as stale and cannot surface an error screen.
    this.#playbackEpoch += 1;
    this.#session.abortPendingRequests();
    this.#session.releaseActiveTranscodeSessions({ reason: "cancel" });
    this.#hlsPlayer.clear();
    this.#clearSubtitleTracks();
    if (this.#videoElement instanceof HTMLVideoElement) {
      this.#videoElement.pause();
      this.#videoElement.removeAttribute("src");
      this.#videoElement.load();
    }
    const videoCount = this.#session.current?.media?.video?.length ?? 0;
    if (videoCount > 1) {
      this.visible = false;
      document.dispatchEvent(new CustomEvent(APP_EVENTS.BACK_TO_PLAYLIST));
      return;
    }
    document.dispatchEvent(new CustomEvent(APP_EVENTS.RESET_TO_PICKER));
  };

  /**
   * Nothing. The waiting interface lives inside the player now, and whether it
   * is on screen is a function of the state, applied by `Player` from
   * `isWaiting`. This component owns what that interface SAYS and never whether
   * it is shown — which is the whole point of deriving outputs from the state.
   *
   * Kept as a no-op so the call sites that used to hide a dialog by hand are
   * harmless rather than having to be found and unpicked one by one.
   *
   * @param {boolean} _value
   */
  set visible(_value) {}

  /** @param {string} value */
  /**
   * Nothing on screen. The overlay carries one line of text and it says what is
   * happening, not which file it is happening to — the file is named in the
   * playlist and in the address bar, and repeating it here cost the status its
   * own line.
   *
   * @param {string} _value
   */
  setFileName(_value) {}

  /** @param {string} value */
  setStatus(value) {
    document.dispatchEvent(
      new CustomEvent(WAITING_EVENTS.STEP, { detail: { value: typeof value === "string" ? value : "" } })
    );
  }

  /**
   * Nothing. The progress bar is gone: a bar promises a known fraction of a
   * known whole, and what the viewer waits for is a time, which is stated in
   * words beside it. Kept as an accepted call so the pipeline's many progress
   * reports need no unpicking.
   *
   * @param {number} _value
   */
  setProgress(_value) {}

  /**
   * Set the progress bar from a single phase's own 0–100% progress, mapped onto
   * that phase's third of the bar. The pre-playback pipeline has three equal
   * phases: 0 = download (metadata/header), 1 = transcode first segment,
   * 2 = buffering. So each phase fills its 33.33% band.
   *
   * @param {0 | 1 | 2} phaseIndex
   * @param {number} phasePercent - Progress within the phase, 0–100.
   * @returns {void}
   */
  #setPhaseProgress(phaseIndex, phasePercent) {
    const span = 100 / 3;
    const pct = Number.isFinite(phasePercent) ? Math.max(0, Math.min(100, phasePercent)) : 0;
    this.#logEvt(`progress phase=${phaseIndex} within=${pct.toFixed(1)}%`);
    this.setProgress(phaseIndex * span + (pct / 100) * span);
  }

  /**
   * @param {{ file?: File, torrentBytes?: Uint8Array, meta?: object, mediaFiles?: { video?: Array<object>, audio?: Array<object>, subtitles?: Array<object> } } | null} payload
   * @returns {Promise<void>}
   */
  async #processPlayback(payload) {
    const file = payload?.file;
    const torrentBytes = payload?.torrentBytes;
    const meta = payload?.meta;
    if (!(file instanceof File) || !(torrentBytes instanceof Uint8Array) || !meta || typeof meta !== "object") {
      return;
    }
    if (!(this.#videoElement instanceof HTMLVideoElement)) {
      throw new Error(Loading.MESSAGES.playerNotReady);
    }
    if (this.#isProcessing) {
      throw new Error(Loading.MESSAGES.alreadyProcessing);
    }

    // A fresh torrent invalidates any pending resume state, cancellation and
    // track selection.
    this.#activeFileIndex = -1;
    this.#resumeState = null;
    this.#cancelRequested = false;
    this.#selectedAudioTrackIndex = 0;
    this.#selectedQualityHeight = 0;
    this.#planTracks = null;
    // Shared-link position/file, applied once the player is shown / files known.
    this.#pendingCurrentTime = Number.isFinite(payload?.currentTime) ? payload.currentTime : null;
    this.#pendingFileIndex = Number.isFinite(payload?.fileIndex) ? payload.fileIndex : null;
    this.#isProcessing = true;

    try {
      this.#hlsPlayer.clear();
      this.#clearSubtitleTracks();
      this.#session.clear();
      const parsed = this.#session.openParsedTorrentDetails({
        fileName: file.name,
        torrentBytes,
        meta
      });
      const mediaFiles = this.#normalizeMediaFiles(payload.mediaFiles, parsed.files);
      const debugState = getDebugState();
      debugState.torrent = {
        fileName: file.name,
        name: typeof parsed.name === "string" ? parsed.name : "",
        infoHashHex: typeof parsed.infoHashHex === "string" ? parsed.infoHashHex : "",
        isMultiFile: Boolean(parsed.isMultiFile),
        files: Array.isArray(parsed.files)
          ? parsed.files.map((entry) => ({
              index: entry.index,
              name: entry.name,
              path: entry.path,
              relativePath: entry.relativePath,
              isVideo: Boolean(entry.isVideo),
              length: entry.length
            }))
          : [],
        media: {
          video: mediaFiles.video,
          audio: mediaFiles.audio,
          subtitles: mediaFiles.subtitles
        }
      };

      document.dispatchEvent(
        new CustomEvent(PLAYER_EVENTS.SET_MEDIA_FILES, {
          detail: mediaFiles
        })
      );
      this.#setPlaylistButtonVisible(mediaFiles.video.length > 1);

      this.visible = true;
      this.setFileName(Loading.MESSAGES.readingTorrentFile(file.name));
      this.setStatus(Loading.MESSAGES.startingTorrentProcessing);
      this.setProgress(0);
      this.setStatus(Loading.MESSAGES.readingMetadata);

      const videoCount = mediaFiles.video.length;
      if (videoCount <= 0) {
        throw new Error(Loading.MESSAGES.noVideoFile);
      }
      // Start the torrent NOW, before the viewer has picked an episode. None of
      // what a cold torrent must do first depends on which file is wanted:
      // announce to the trackers, connect to peers, be unchoked by them. On a
      // single-video torrent the file is known already, so the two pieces at
      // its edges — the ones the codec probe reads — are fetched too. Measured
      // 2026-08-04 on a cold 7.4 GB torrent: 6.7 s of the 10.3 s before
      // playback was exactly that, and all of it happened after the file was
      // chosen. Reading a list of episodes takes about as long.
      this.#warmSourceInBackground(videoCount === 1 ? mediaFiles.video[0].index : null);
      const sharedVideoFileIndex = this.#sharedVideoFileIndex();
      if (videoCount === 1) {
        const videoFileIndex = mediaFiles.video[0].index;
        await this.#playVideoFile(videoFileIndex);
        void this.#loadSubtitlesForVideo(videoFileIndex).catch((e) => {
          if (!this.#isAbortError(e)) {
            console.warn("[torrent-tv][subtitles] load failed:", e);
          }
        });
      } else if (sharedVideoFileIndex != null) {
        // A shared link targeted a specific file of a multi-file torrent — open
        // it directly instead of the playlist.
        this.#pendingFileIndex = null;
        await this.#playVideoFile(sharedVideoFileIndex);
        void this.#loadSubtitlesForVideo(sharedVideoFileIndex).catch((e) => {
          if (!this.#isAbortError(e)) {
            console.warn("[torrent-tv][subtitles] load failed:", e);
          }
        });
      } else {
        this.setStatus(Loading.MESSAGES.chooseVideoFile);
        this.setProgress(100);
        document.dispatchEvent(new CustomEvent(LOADING_EVENTS.PLAYBACK_READY, {
          detail: { viewerWantsPlayback: this.#viewerWantsPlayback() }
        }));
        document.dispatchEvent(new CustomEvent(PLAYER_EVENTS.OPEN_PLAYLIST));
        return;
      }

      this.setProgress(100);
      document.dispatchEvent(new CustomEvent(LOADING_EVENTS.PLAYBACK_READY, {
          detail: { viewerWantsPlayback: this.#viewerWantsPlayback() }
        }));
    } finally {
      this.#isProcessing = false;
    }
  }

  /**
   * Get the proxy working on this torrent while the viewer is still choosing.
   *
   * Never awaited and never allowed to fail loudly: everything it does, the
   * ordinary playback path does again for itself, and both steps are cached, so
   * the worst case of a failure here is the behaviour we had before. It is
   * bound to the current attempt, so a torrent abandoned mid-choice cannot have
   * a late warm-up land on top of the next one.
   *
   * @param {number | null} fileIndex - The file to fetch the edges of, when the
   *   torrent holds exactly one video. Null for a pack: warming twenty
   *   episodes' edges would spend the pool owner's bandwidth on nineteen files
   *   nobody opened.
   * @returns {void}
   */
  #warmSourceInBackground(fileIndex) {
    const epoch = this.#playbackEpoch;
    void (async () => {
      try {
        const transport = await this.#acquireTransport();
        if (epoch !== this.#playbackEpoch) {
          return;
        }
        const sourceKey = await this.#session.registerSourceOnProxy(transport);
        if (epoch !== this.#playbackEpoch) {
          return;
        }
        const response = await transport.fetch(`/api/sources/${sourceKey}/warm`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(fileIndex === null ? {} : { fileIndex })
        });
        this.#logEvt(`warm-up requested (${response.ok ? "accepted" : `refused ${response.status}`})`);
      } catch (error) {
        if (this.#isAbortError(error)) {
          return;
        }
        this.#logEvt(`warm-up skipped: ${error instanceof Error ? error.message : String(error)}`);
      }
    })();
  }

  /**
   * @param {{ video?: Array<object>, audio?: Array<object>, subtitles?: Array<object> } | undefined} mediaFiles
   * @param {Array<object>} parsedFiles
   * @returns {{ video: Array<object>, audio: Array<object>, subtitles: Array<object> }}
   */
  /**
   * Magnet flow: the file list is unknown locally — register the magnet on a
   * proxy, wait for the swarm metadata (`/api/sources/:key/files`), then
   * continue exactly like the parsed-torrent flow.
   *
   * @param {string} magnetUri
   * @returns {Promise<void>}
   */
  async #processMagnetPlayback(magnetUri, currentTime = null, fileIndex = null) {
    if (typeof magnetUri !== "string" || magnetUri.trim().length === 0) {
      return;
    }
    if (!(this.#videoElement instanceof HTMLVideoElement)) {
      throw new Error(Loading.MESSAGES.playerNotReady);
    }
    if (this.#isProcessing) {
      throw new Error(Loading.MESSAGES.alreadyProcessing);
    }

    // A fresh source invalidates any pending resume state, cancellation and
    // track selection (same as the parsed-torrent flow).
    this.#activeFileIndex = -1;
    this.#resumeState = null;
    this.#cancelRequested = false;
    this.#selectedAudioTrackIndex = 0;
    this.#selectedQualityHeight = 0;
    this.#planTracks = null;
    // Shared-link position/file, applied once the player is shown / files known.
    this.#pendingCurrentTime = Number.isFinite(currentTime) ? currentTime : null;
    this.#pendingFileIndex = Number.isFinite(fileIndex) ? fileIndex : null;
    this.#isProcessing = true;

    try {
      this.#hlsPlayer.clear();
      this.#clearSubtitleTracks();
      this.#session.clear();
      const current = this.#session.openMagnetDetails({ magnetUri });

      // Display name from the magnet's dn parameter until metadata arrives.
      let displayName = "Magnet link";
      try {
        const dn = new URLSearchParams(magnetUri.slice(magnetUri.indexOf("?") + 1)).get("dn");
        if (dn && dn.trim().length > 0) {
          displayName = dn.trim();
        }
      } catch {
        // Keep the fallback name.
      }

      this.visible = true;
      this.setFileName(displayName);
      this.setProgress(0);
      this.setStatus(Loading.MESSAGES.fetchingMagnetMetadata);

      const transport = await this.#acquireTransport();
      this.#throwIfCancelled();
      if (!transport) {
        throw new Error(Loading.MESSAGES.noProxyAndNoWebseed);
      }
      const sourceKey = await this.#session.registerSourceOnProxy(transport);
      this.#throwIfCancelled();

      // Poll for the swarm metadata: the proxy returns `pending` quickly while
      // it keeps fetching, so a single request never races the transport
      // timeout and a slow-to-appear magnet is given a real chance instead of
      // failing on the first miss (the metadata often arrives seconds later).
      const metadataDeadline = Date.now() + MAGNET_METADATA_TIMEOUT_MS;
      let payload = null;
      for (;;) {
        this.#throwIfCancelled();
        const response = await transport.fetch(
          `/api/sources/${encodeURIComponent(sourceKey)}/files?maxWaitMs=8000`,
          { signal: this.#session.abortController.signal, timeoutMs: 15_000 }
        );
        this.#throwIfCancelled();
        if (response.ok) {
          const body = await response.json();
          if (!body?.pending) {
            payload = body;
            break;
          }
        }
        // `pending` (or a transient non-ok) — keep the status up and retry
        // until the wall-clock deadline.
        if (Date.now() >= metadataDeadline) {
          throw new Error(Loading.MESSAGES.magnetMetadataFailed);
        }
        this.setStatus(Loading.MESSAGES.fetchingMagnetMetadata);
        await new Promise((resolve) => setTimeout(resolve, 2_000));
      }

      const name =
        typeof payload?.name === "string" && payload.name.length > 0 ? payload.name : displayName;
      const files = normalizeRemoteFileList(name, payload?.files);
      if (files.length === 0) {
        throw new Error(Loading.MESSAGES.magnetMetadataFailed);
      }

      current.name = name;
      current.files = files;
      current.isMultiFile = files.length > 1;
      this.setFileName(name);

      const mediaFiles = classifyMediaFiles(files);
      this.#subtitleFiles = mediaFiles.subtitles;
      document.dispatchEvent(
        new CustomEvent(PLAYER_EVENTS.SET_MEDIA_FILES, {
          detail: mediaFiles
        })
      );
      this.#setPlaylistButtonVisible(mediaFiles.video.length > 1);

      const videoCount = mediaFiles.video.length;
      if (videoCount <= 0) {
        throw new Error(Loading.MESSAGES.noVideoFile);
      }
      // Start the torrent NOW, before the viewer has picked an episode. None of
      // what a cold torrent must do first depends on which file is wanted:
      // announce to the trackers, connect to peers, be unchoked by them. On a
      // single-video torrent the file is known already, so the two pieces at
      // its edges — the ones the codec probe reads — are fetched too. Measured
      // 2026-08-04 on a cold 7.4 GB torrent: 6.7 s of the 10.3 s before
      // playback was exactly that, and all of it happened after the file was
      // chosen. Reading a list of episodes takes about as long.
      this.#warmSourceInBackground(videoCount === 1 ? mediaFiles.video[0].index : null);
      const sharedVideoFileIndex = this.#sharedVideoFileIndex();
      if (videoCount === 1) {
        const videoFileIndex = mediaFiles.video[0].index;
        await this.#playVideoFile(videoFileIndex);
        void this.#loadSubtitlesForVideo(videoFileIndex).catch((e) => {
          if (!this.#isAbortError(e)) {
            console.warn("[torrent-tv][subtitles] load failed:", e);
          }
        });
      } else if (sharedVideoFileIndex != null) {
        // A shared link targeted a specific file of a multi-file torrent — open
        // it directly instead of the playlist.
        this.#pendingFileIndex = null;
        await this.#playVideoFile(sharedVideoFileIndex);
        void this.#loadSubtitlesForVideo(sharedVideoFileIndex).catch((e) => {
          if (!this.#isAbortError(e)) {
            console.warn("[torrent-tv][subtitles] load failed:", e);
          }
        });
      } else {
        this.setStatus(Loading.MESSAGES.chooseVideoFile);
        this.setProgress(100);
        document.dispatchEvent(new CustomEvent(LOADING_EVENTS.PLAYBACK_READY, {
          detail: { viewerWantsPlayback: this.#viewerWantsPlayback() }
        }));
        document.dispatchEvent(new CustomEvent(PLAYER_EVENTS.OPEN_PLAYLIST));
        return;
      }

      this.setProgress(100);
      document.dispatchEvent(new CustomEvent(LOADING_EVENTS.PLAYBACK_READY, {
          detail: { viewerWantsPlayback: this.#viewerWantsPlayback() }
        }));
    } finally {
      this.#isProcessing = false;
    }
  }

  /**
   * Number of video files in the current source. Used to decide whether an
   * error should preserve the parsed source (so the playlist stays usable) —
   * matches the criterion the error screen uses to offer "Back to episodes".
   *
   * @returns {number}
   */
  #videoFileCount() {
    const files = this.#session.current?.files;
    if (!Array.isArray(files)) {
      return 0;
    }
    return files.filter((entry) => entry?.isVideo === true).length;
  }

  /**
   * Reconstruct a shareable URL for the current source. Always a `?magnet=…`
   * link: for a magnet source the original URI; for a `.torrent`-file source a
   * magnet BUILT from the infohash (+ name + trackers) — NOT the whole torrent
   * file base64-embedded, which produced multi-KB URLs that browsers truncate
   * past their length limit. The recipient's proxy fetches metadata from the
   * swarm/DHT, the same path a normal magnet already uses. Empty when there is
   * no current source or no infohash to build from.
   *
   * (Position-resume is a future extension, ties to the cross-device handoff
   * roadmap item.)
   *
   * @returns {string}
   */
  /**
   * Keep the address bar describing what is on screen: which torrent, which
   * file, and where in it.
   *
   * The requirement it serves is exactly one sentence long — a bookmark must
   * reopen the same file of the same torrent at the same moment, with no extra
   * steps — and it decides the shape. The magnet is long and full of characters
   * that cannot sit in a path segment, so these are query parameters, the same
   * three the share link already builds and `torrent.js` already parses on
   * load.
   *
   * `replaceState`, never `push`: the position changes constantly, and pushing
   * would bury the viewer's real history under hundreds of entries of the same
   * film. The cost is one synchronous call at the rate below.
   *
   * Silent when there is nothing to describe — no source, no infohash, or the
   * player has not started — so the address bar is never half-written.
   *
   * @returns {void}
   */
  /**
   * Build a new transcode session for the file already on screen, continuing
   * from where the viewer was.
   *
   * A session can vanish under a player that is otherwise fine: the proxy
   * disposes it after the browser has been away, or the proxy restarts. Every
   * request then answers 404, and the player has no way to interpret that — it
   * polled a dead id indefinitely behind a spinner (field 2026-08-06, eleven
   * minutes of it). Nothing needs to be fetched again to recover: the source
   * and the file are in memory and the position is on the video element, so
   * the honest response to "your session is gone" is to make another one.
   *
   * Only ever one rebuild at a time, and never during the loading flow, which
   * owns its own failure path.
   *
   * @returns {Promise<void>}
   */
  async #rebuildGoneSession() {
    if (this.#rebuildingSession || this.#isProcessing) {
      return;
    }
    const fileIndex = this.#activeFileIndex;
    if (!Number.isInteger(fileIndex) || fileIndex < 0) {
      return;
    }
    const video = this.#videoElement;
    const position = video instanceof HTMLVideoElement ? video.currentTime : 0;
    this.#rebuildingSession = true;
    this.#logEvt(`session gone — rebuilding at ${position.toFixed(1)}s`);
    try {
      this.#pendingCurrentTime = position > 0 ? position : null;
      await this.#playVideoFile(fileIndex);
    } catch (error) {
      this.#logEvt(`session rebuild failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.#rebuildingSession = false;
    }
  }

  /**
   * Go where the Back or Forward button just pointed.
   *
   * The browser restores an address and nothing else — everything the
   * application held in memory belongs to the state being left — so the address
   * is the whole instruction. {@link decideNavigation} turns it into the
   * cheapest correct action for where we already are: another torrent has to be
   * loaded, another file of the SAME torrent only opened, the same file only
   * seeked, and a difference of a second is not a navigation at all.
   *
   * Nothing here writes history. The rule that decides push-or-replace already
   * makes that safe — after a restore the address names the state, so a write
   * replaces — but a `timeupdate` from the file being left can arrive
   * mid-transition, when the address and the player disagree, and that one
   * WOULD push. Hence the flag.
   *
   * @returns {Promise<void>}
   */
  async #onHistoryNavigate() {
    const target = readUrlState(location.search);
    const video = this.#videoElement;
    const current = {
      magnet: this.#currentMagnetUri(),
      fileIndex: this.#activeFileIndex >= 0 ? this.#activeFileIndex : -1,
      currentTime: video instanceof HTMLVideoElement ? Math.floor(video.currentTime) : 0
    };
    const { action, fileIndex, currentTime } = decideNavigation(current, target);
    if (action === "none") {
      return;
    }
    this.#logEvt(`history → ${action} file=${fileIndex} at=${currentTime}s`);
    this.#navigatingHistory = true;
    try {
      if (action === "seek") {
        if (video instanceof HTMLVideoElement) {
          video.currentTime = currentTime;
        }
        return;
      }
      if (action === "picker") {
        document.dispatchEvent(new CustomEvent(APP_EVENTS.RESET_TO_PICKER));
        return;
      }
      if (action === "playlist") {
        document.dispatchEvent(new CustomEvent(APP_EVENTS.BACK_TO_PLAYLIST));
        return;
      }
      if (action === "load-source") {
        // The whole source again, with the file and position the entry names —
        // the same path a shared link takes, which already accepts both.
        document.dispatchEvent(new CustomEvent(LOADING_EVENTS.PROCESS_MAGNET, {
          detail: {
            magnetUri: target.magnet,
            fileIndex: fileIndex >= 0 ? fileIndex : null,
            currentTime: currentTime > 0 ? currentTime : null
          }
        }));
        return;
      }
      // open-file: the torrent is already loaded, so only the file changes.
      this.#pendingCurrentTime = currentTime > 0 ? currentTime : null;
      await this.#playVideoFile(fileIndex);
    } catch (error) {
      this.#logEvt(`history navigation failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.#navigatingHistory = false;
    }
  }

  #reflectStateInUrl() {
    if (this.#navigatingHistory) {
      return;
    }
    const magnet = this.#currentMagnetUri();
    if (magnet.length === 0) {
      // Nothing to say. The address is cleared only when the viewer DELIBERATELY
      // leaves — see the RESET_TO_PICKER handler — never merely because the
      // source is momentarily absent. A failure clears the session too, and
      // wiping the address then threw away the one record of what was being
      // watched and where: after a router reboot the error screen's Retry had
      // nothing to return to (reported 2026-08-06).
      return;
    }
    const video = this.#videoElement;
    const next = {
      magnet,
      fileIndex: this.#activeFileIndex >= 0 ? this.#activeFileIndex : -1,
      currentTime: video instanceof HTMLVideoElement ? Math.floor(video.currentTime) : 0
    };
    const current = readUrlState(location.search);
    const how = decideHistoryWrite(current, next);
    // Moving on to the next episode means this one is finished, so the entry
    // being left loses its position and Back opens it from the start. Reading
    // the intention from the DESTINATION avoids having to decide how near the
    // end counts as the end — credits run for different lengths in every
    // release, and most people skip them, so no threshold could be right.
    if (
      how === "push" &&
      current.magnet === next.magnet &&
      isAdvanceToNext(current.fileIndex, next.fileIndex, this.#videoFileIndexes())
    ) {
      this.#writeHistory("replace", { ...current, currentTime: 0 });
    }
    this.#writeHistory(how, next);
  }

  /**
   * @param {"push" | "replace"} how
   * @param {{ magnet: string, fileIndex: number, currentTime: number }} state
   * @returns {void}
   */
  #writeHistory(how, state) {
    if (how === "none") {
      return;
    }
    const url = `${location.origin}${location.pathname}${buildUrlSearch(state)}`;
    try {
      if (how === "push") {
        history.pushState(null, "", url);
      } else {
        history.replaceState(null, "", url);
      }
    } catch {
      // A browser that refuses (rate limit, sandboxed frame) keeps the address
      // it had; nothing about playback depends on this.
    }
  }

  /**
   * The magnet for whatever is loaded, or "" when there is nothing to name.
   *
   * @returns {string}
   */
  #currentMagnetUri() {
    const current = this.#session.current;
    if (current?.sourceType === "magnet") {
      return typeof current.sourceValue === "string" ? current.sourceValue : "";
    }
    if (current?.sourceType === "torrent") {
      return this.#buildMagnetFromCurrent(current);
    }
    return "";
  }

  /**
   * Indexes of the playable files, in the order the playlist shows them — what
   * "the next one" means to a viewer, which is not the next index in a pack
   * that also carries subtitles, samples and artwork.
   *
   * @returns {number[]}
   */
  #videoFileIndexes() {
    const files = this.#session.current?.files;
    if (!Array.isArray(files)) {
      return [];
    }
    const indexes = [];
    for (let index = 0; index < files.length; index += 1) {
      if (files[index]?.isVideo === true) {
        indexes.push(index);
      }
    }
    return indexes;
  }

  #buildShareUrl() {
    const current = this.#session.current;
    const base = `${location.origin}${location.pathname}`;
    let magnetUri = "";
    if (current?.sourceType === "magnet") {
      magnetUri = typeof current.sourceValue === "string" ? current.sourceValue : "";
    } else if (current?.sourceType === "torrent") {
      magnetUri = this.#buildMagnetFromCurrent(current);
    }
    if (magnetUri.length === 0) {
      return "";
    }
    let url = `${base}?magnet=${encodeURIComponent(magnetUri)}`;
    // For a multi-file torrent, carry which file is playing so the recipient
    // opens the same one directly instead of the playlist (`fileIndex` — the
    // same name the receiver parses; see torrent.js #loadFromUrl).
    if (this.#activeFileIndex >= 0 && this.#videoFileCount() > 1) {
      url += `&fileIndex=${this.#activeFileIndex}`;
    }
    return url;
  }

  /**
   * The shared-link file index (`#pendingFileIndex`) when it points to a valid
   * video file of the current source, else null. Lets a shared link open a
   * specific file of a multi-file torrent directly instead of the playlist.
   *
   * @returns {number | null}
   */
  #sharedVideoFileIndex() {
    const fileIndex = this.#pendingFileIndex;
    if (fileIndex == null) {
      return null;
    }
    const file = this.#session.current?.files?.[fileIndex];
    return file?.isVideo === true ? fileIndex : null;
  }

  /**
   * Build a magnet URI from the parsed torrent details of the current source:
   * `magnet:?xt=urn:btih:<hash>&dn=<name>&tr=<tracker>…`. Keeps the link short
   * (the swarm/DHT supplies the metadata) instead of embedding the whole file.
   *
   * @param {{ infoHashHex?: string, name?: string, announce?: string, announceList?: unknown }} current
   * @returns {string} Magnet URI, or "" when the infohash is unavailable.
   */
  #buildMagnetFromCurrent(current) {
    const hash = typeof current?.infoHashHex === "string" ? current.infoHashHex.trim() : "";
    if (!/^[0-9a-f]{40}$/i.test(hash)) {
      return "";
    }
    const parts = [`magnet:?xt=urn:btih:${hash.toLowerCase()}`];
    if (typeof current.name === "string" && current.name.trim().length > 0) {
      parts.push(`dn=${encodeURIComponent(current.name.trim())}`);
    }
    const trackers = new Set();
    const addTracker = (candidate) => {
      const trackerString = this.#toTrackerString(candidate);
      if (trackerString && /^(https?|udp|wss?):\/\//i.test(trackerString)) {
        trackers.add(trackerString);
      }
    };
    addTracker(current.announce);
    if (Array.isArray(current.announceList)) {
      for (const tier of current.announceList) {
        if (Array.isArray(tier)) {
          tier.forEach(addTracker);
        } else {
          addTracker(tier);
        }
      }
    }
    for (const tracker of trackers) {
      parts.push(`tr=${encodeURIComponent(tracker)}`);
    }
    return parts.join("&");
  }

  /**
   * Coerce a tracker value to a string. The bencode parser may leave
   * announce-list entries as raw byte arrays; decode those as UTF-8.
   *
   * @param {unknown} value
   * @returns {string}
   */
  #toTrackerString(value) {
    if (typeof value === "string") {
      return value.trim();
    }
    if (value instanceof Uint8Array) {
      try {
        return new TextDecoder().decode(value).trim();
      } catch {
        return "";
      }
    }
    if (Array.isArray(value) && value.every((byte) => Number.isInteger(byte))) {
      try {
        return new TextDecoder().decode(Uint8Array.from(value)).trim();
      } catch {
        return "";
      }
    }
    return "";
  }

  /**
   * A data-channel request that timed out (as opposed to a closed channel or a
   * genuine protocol error). Transient: the request can be retried while the
   * connection stays up — used to keep waiting on a slow torrent instead of
   * failing.
   *
   * @param {unknown} error
   * @returns {boolean}
   */
  #isTransientRequestTimeout(error) {
    return error instanceof Error && /request timed out/i.test(error.message);
  }

  /**
   * A transport-level failure — the WebRTC data channel closed while a
   * loading request was in flight — as opposed to a content/logic error.
   * Field-diagnosed: ICE connects, then the channel dies ~6s later while
   * source registration or the playback-plan request is still in flight.
   * `#onTransportLost`'s automatic reconnect ladder deliberately bails out
   * while a loading flow is running (`#isProcessing`), on the assumption that
   * the loading flow's own failure path handles it — this is that path. Not
   * permanent: a retry acquires a FRESH proxy (`#acquireTransport` never
   * reuses a dead one), so callers should treat it like the data-starvation
   * stall (retryable), not a dead end.
   *
   * @param {unknown} error
   * @returns {boolean}
   */
  #isTransportClosedError(error) {
    return error instanceof Error && /channel closed|channel is not open/i.test(error.message);
  }

  /**
   * Build a retryable loading-stage error and arm a resume so the error
   * screen offers a Retry that restarts this file from the beginning. Used
   * for failure modes that are not permanent — data starvation (few peers)
   * and a mid-loading transport loss (see #isTransportClosedError) — so
   * neither dead-ends the viewer.
   *
   * @param {number} fileIndex
   * @param {string} [message] - Defaults to the data-starvation stall message.
   * @returns {Error}
   */
  /**
   * Say, once, that the wait has gone past what is ordinary.
   *
   * Called instead of failing. The status line keeps showing live peers, speed
   * and progress underneath, so a torrent that comes to life is visible
   * immediately; this only replaces the implication that something must happen
   * soon.
   *
   * @param {number} deadline - When the ordinary wait was to have ended.
   * @returns {void}
   */
  #noteLongWait(deadline) {
    if (this.#longWaitAnnounced || Date.now() < deadline) {
      return;
    }
    this.#longWaitAnnounced = true;
    this.#logEvt("no peers after the ordinary wait — saying so and continuing");
    this.setStatus(Loading.MESSAGES.noPeersKeepWaiting);
  }

  #armRetryableStall(fileIndex, message = Loading.MESSAGES.headerDownloadStalled) {
    if (this.#session.current) {
      // Where the viewer actually was. Zero was written here regardless, so
      // Retry after a lost connection started the film from the beginning —
      // reported 2026-08-06 after a router reboot forty minutes in. The
      // position is on the video element until the player is torn down, and
      // the address bar holds it afterwards, so one of the two always knows.
      const video = this.#videoElement;
      const playing = video instanceof HTMLVideoElement ? Math.floor(video.currentTime) : 0;
      const remembered = readUrlState(location.search).currentTime;
      this.#resumeState = {
        fileIndex,
        positionSeconds: playing > 0 ? playing : Math.max(0, remembered),
        sessionCurrent: this.#session.current
      };
    }
    const error = new Error(message);
    error.canRetry = true;
    return error;
  }

  #normalizeMediaFiles(mediaFiles, parsedFiles) {
    const video = Array.isArray(mediaFiles?.video) ? mediaFiles.video : parsedFiles.filter((entry) => entry.isVideo);
    const audio = Array.isArray(mediaFiles?.audio) ? mediaFiles.audio : [];
    const subtitles = Array.isArray(mediaFiles?.subtitles) ? mediaFiles.subtitles : [];
    this.#subtitleFiles = subtitles;
    return { video, audio, subtitles };
  }

  /**
   * @param {number} fileIndex
   * @returns {Promise<void>}
   */
  async #switchToVideoFile(fileIndex) {
    if (!(this.#videoElement instanceof HTMLVideoElement)) {
      throw new Error(Loading.MESSAGES.playerNotReady);
    }
    this.#cancelRequested = false;
    this.#isProcessing = true;
    try {
      this.#hlsPlayer.clear();
      this.#clearSubtitleTracks();
      // The same <video> element serves every file, and it keeps the position
      // the last one was left at. Attaching a new stream to it therefore
      // resumed the NEW episode wherever the PREVIOUS one had got to — a
      // viewer who switched forty minutes into episode one began episode two
      // forty minutes in. Only when nothing has asked for a position: a resume
      // from the address, from Retry or from Back sets one before getting here,
      // and that is exactly the case this must not overwrite.
      if (this.#pendingCurrentTime === null && this.#videoElement.currentTime > 0) {
        this.#videoElement.currentTime = 0;
      }
      // Release the previous file's transcode session so the proxy stops its
      // ffmpeg immediately. Otherwise switching episodes leaves the old encode
      // running in parallel with the new one, splitting the (ARM) CPU and
      // dropping both below realtime → stalls.
      this.#session.releaseActiveTranscodeSessions({ reason: "switch-file" });
      this.setStatus(Loading.MESSAGES.switchingToSelectedFile);
      await this.#playVideoFile(fileIndex);
      void this.#loadSubtitlesForVideo(fileIndex).catch((e) => {
        if (!this.#isAbortError(e)) {
          console.warn("[torrent-tv][subtitles] load failed:", e);
        }
      });
      this.setProgress(100);
      document.dispatchEvent(new CustomEvent(LOADING_EVENTS.PLAYBACK_READY, {
          detail: { viewerWantsPlayback: this.#viewerWantsPlayback() }
        }));
    } finally {
      this.#isProcessing = false;
    }
  }

  /**
   * @param {number} fileIndex
   * @returns {Promise<void>}
   */
  async #playVideoFile(fileIndex) {
    if (!Number.isInteger(fileIndex) || fileIndex < 0) {
      throw new Error(Loading.MESSAGES.noVideoFile);
    }
    const current = this.#session.current;
    const file = Array.isArray(current?.files) ? current.files[fileIndex] : null;
    if (!file || file.isVideo !== true) {
      throw new Error(Loading.MESSAGES.selectedFileNotFound);
    }
    // Reset the source resolution; it is set again only when the proxy plan
    // provides it below. This gates the quality menu to proxy-served streams
    // (a direct webseed play, which cannot be transcoded, leaves it 0 → no menu).
    this.#sourceVideoWidth = 0;
    this.#sourceVideoHeight = 0;
    // A new file answers the quality question afresh; the previous one's
    // height must not survive into its menu.
    this.#autoEffectiveHeight = 0;

    const hasWebseed = Array.isArray(current?.webSeeds) && current.webSeeds.length > 0;

    if (hasWebseed) {
      this.setStatus(Loading.MESSAGES.startingDirectPlayback);
      this.setProgress(70);
      await this.#session.streamFileToVideo(fileIndex, this.#videoElement);
      try {
        await this.#ensureVideoReady();
        this.#setActiveMediaFile(fileIndex);
      } catch (error) {
        if (!this.#isUnsupportedError(error)) {
          throw error;
        }
        this.setStatus(Loading.MESSAGES.fallingBackToTranscode);
        try {
          await this.#playWithProxyTranscode(fileIndex, { transcodeAudio: false });
          this.#setActiveMediaFile(fileIndex);
        } catch (transcodeError) {
          if (!this.#isUnsupportedError(transcodeError)) {
            throw transcodeError;
          }
          this.setStatus(Loading.MESSAGES.fallingBackToVideoTranscode);
          await this.#playWithProxyTranscode(fileIndex, { transcodeVideo: true, transcodeAudio: false });
          this.#setActiveMediaFile(fileIndex);
        }
      }
      return;
    }

    this.setStatus(Loading.MESSAGES.selectingProxy);
    this.#setPhaseProgress(0, 10); // phase 0 (download) — small floor before stats arrive
    // Cold-start timing (proxy-served flow): t0 = entry, filled through the
    // phases and logged once on a successful prebuffer.
    this.#coldStart = { t0: performance.now() };
    // Honest status split: the pick is instant; the time is the WebRTC connect.
    // Relabel to "Connecting to proxy" once the selector starts the connect.
    const transport = await this.#acquireTransport({
      onConnecting: () => this.setStatus(Loading.MESSAGES.connectingToProxy)
    });
    this.#throwIfCancelled();
    if (!transport) {
      throw new Error(Loading.MESSAGES.noProxyAndNoWebseed);
    }
    this.#coldStart.t1 = performance.now();
    // The connection is made, so stop saying it is being made. Nothing cleared
    // this step before, and the next one was published much later — so the
    // overlay read "Connecting to proxy…" while showing peers and a download
    // rate, which can only come FROM a proxy that is already connected. A step
    // that has finished must be replaced at the moment it finishes.
    this.setStatus(Loading.MESSAGES.fetchingMetadata);

    // Register the torrent source early so we can poll live stats while
    // the proxy pre-fetches file metadata (MOOV atom / EBML headers).
    // prepareProxyPlaybackPlan will reuse the cached sourceKey.
    this.setStatus(Loading.MESSAGES.fetchingMetadata);
    this.#setPhaseProgress(0, 20); // phase 0 floor; header download % (stats poll) drives the rest
    let earlySourceKey;
    try {
      earlySourceKey = await this.#session.registerSourceOnProxy(transport);
    } catch (registerError) {
      // See #isTransportClosedError: a transport death here must not become a
      // dead-end fatal error either — same treatment as the plan-poll loop
      // below.
      if (this.#isTransportClosedError(registerError)) {
        throw this.#armRetryableStall(fileIndex, Loading.MESSAGES.connectionLost);
      }
      throw registerError;
    }
    const stopStatsPoll = this.#startTorrentStatsPoll(transport, earlySourceKey, fileIndex);

    let prepared;
    try {
      // Poll the playback plan until the file header has downloaded. On a cold
      // torrent (peers still connecting) the proxy returns `pending` quickly
      // instead of blocking — so a single request never races the transport's
      // 60 s timeout. The stats poll above keeps showing live peers/speed/% the
      // whole time. Bounded so a truly dead torrent (no peers) still fails.
      const planDeadline = Date.now() + Loading.PLAN_WAIT_MS;
      for (;;) {
        this.#throwIfCancelled();
        try {
          prepared = await this.#session.prepareProxyPlaybackPlan(fileIndex, transport);
        } catch (planError) {
          // A slow torrent (few peers) can keep the proxy busy waiting on
          // pieces long enough for the data-channel request itself to time out,
          // even though the connection is healthy. That is data starvation, not
          // a fatal error: keep polling (the stats poll keeps peers/speed/% on
          // screen) until the wall-clock budget is spent, instead of dropping to
          // the error screen.
          if (this.#isTransientRequestTimeout(planError) && (this.#proxy?.isOpen ?? true)) {
            this.#logEvt("plan request timed out while waiting on pieces — keep waiting");
            this.#noteLongWait(planDeadline);
            await new Promise((resolve) => setTimeout(resolve, 2_000));
            continue;
          }
          // The transport itself died mid-request (see #isTransportClosedError)
          // — retryable, not a dead end.
          if (this.#isTransportClosedError(planError)) {
            this.#logEvt("transport closed while polling playback plan — retryable");
            throw this.#armRetryableStall(fileIndex, Loading.MESSAGES.connectionLost);
          }
          throw planError;
        }
        if (!prepared.pending) {
          break;
        }
        this.#noteLongWait(planDeadline);
        await new Promise((resolve) => setTimeout(resolve, 2_000));
      }
    } finally {
      stopStatsPoll();
    }

    this.#coldStart.t2 = performance.now();
    this.setStatus(Loading.MESSAGES.checkingCompatibility);
    this.#setPhaseProgress(0, 100); // header probed → phase 0 (download) complete

    // Track inventory of the active file (drives the audio menu and the
    // embedded-subtitle loading).
    this.#planTracks = {
      audio: Array.isArray(prepared.audioTracks) ? prepared.audioTracks : [],
      subtitles: Array.isArray(prepared.subtitleTracks) ? prepared.subtitleTracks : []
    };
    // Source coded resolution — drives the manual quality menu.
    this.#sourceVideoWidth = Number.isFinite(prepared.videoWidth) ? prepared.videoWidth : 0;
    this.#sourceVideoHeight = Number.isFinite(prepared.videoHeight) ? prepared.videoHeight : 0;
    // What this proxy measured itself taking to produce a first segment. Used
    // for the gap between the file being downloaded and a segment existing,
    // where nothing else has a rate yet.
    this.#expectedFirstSegmentSeconds =
      Number.isFinite(prepared.expectedFirstSegmentMs) && prepared.expectedFirstSegmentMs > 0
        ? prepared.expectedFirstSegmentMs / 1000
        : null;
    this.#expectedSessionCreateSeconds =
      Number.isFinite(prepared.expectedSessionCreateMs) && prepared.expectedSessionCreateMs > 0
        ? prepared.expectedSessionCreateMs / 1000
        : null;
    if (this.#selectedAudioTrackIndex >= this.#planTracks.audio.length) {
      this.#selectedAudioTrackIndex = 0;
    }

    const codecSupport = await this.#predictCodecSupport({
      audioCodec: prepared.audioCodec,
      videoCodec: prepared.videoCodec
    });
    // Decide per stream, independently: transcode the video track only if the
    // browser cannot decode the video codec, and the audio track only if it
    // cannot decode the audio codec.  The proxy's advisory `mode` is NOT used
    // to force audio transcoding — we transcode strictly what is unsupported.
    //
    // A forced quality (viewer picked a resolution, not Auto) ALSO forces a
    // video re-encode even for a directly-playable codec: the whole point is to
    // downscale for bandwidth, which only the transcode path can do. Auto
    // (`#selectedQualityHeight === 0`) keeps the copy-if-playable behaviour.
    const forceQualityTranscode = this.#selectedQualityHeight > 0;
    const shouldTranscodeVideo = codecSupport.videoSupported === false || forceQualityTranscode;
    const shouldTranscodeAudio = codecSupport.audioSupported === false;
    this.#debug("playback decision", {
      fileIndex,
      container: prepared.container,
      audioCodec: prepared.audioCodec,
      videoCodec: prepared.videoCodec,
      audioSupported: codecSupport.audioSupported,
      videoSupported: codecSupport.videoSupported,
      plannerMode: prepared.mode,
      shouldTranscodeVideo,
      shouldTranscodeAudio,
      forceQualityTranscode,
      transport: transport.isHttp ? "http" : "webrtc"
    });
    const directRetryKey = this.#buildDirectRetryCacheKey(fileIndex, prepared);
    const directHintKey = this.#buildDirectPlaybackHintKey(prepared);
    const directHint = this.#getDirectPlaybackHint(directHintKey);

    // A non-default audio track can only be delivered by the proxy remuxing
    // with `-map 0:a:N` — direct play always carries the container's default
    // track, so it is off the table for this attempt.
    const forceAudioRemux = this.#selectedAudioTrackIndex > 0;

    // Direct URL probing only works for HTTP transports — WebRTC uses fake URLs.
    // A forced quality must go through the transcode path, so skip every
    // direct-play shortcut when it is set.
    const canProbeDirectUrl = transport.isHttp && !forceAudioRemux && !forceQualityTranscode;

    if (
      canProbeDirectUrl &&
      shouldTranscodeVideo &&
      !shouldTranscodeAudio &&
      !this.#directPlaybackUnsupportedCache.has(directRetryKey) &&
      directHint !== "unsupported"
    ) {
      const directSucceeded = await this.#tryPlayDirectUrl(prepared.directUrl, {
        statusMessage: Loading.MESSAGES.probingDirectPlayback,
        progress: 58
      });
      if (directSucceeded) {
        this.#setDirectPlaybackHint(directHintKey, true);
        this.#directPlaybackUnsupportedCache.delete(directRetryKey);
        this.#setActiveMediaFile(fileIndex);
        return;
      }
      this.#setDirectPlaybackHint(directHintKey, false);
      this.#directPlaybackUnsupportedCache.add(directRetryKey);
    }

    if (shouldTranscodeAudio || shouldTranscodeVideo || forceAudioRemux) {
      if (
        canProbeDirectUrl &&
        shouldTranscodeAudio &&
        !this.#directPlaybackUnsupportedCache.has(directRetryKey) &&
        directHint !== "unsupported"
      ) {
        const directSucceeded = await this.#tryPlayDirectUrl(prepared.directUrl, {
          statusMessage: Loading.MESSAGES.probingDirectPlayback,
          progress: 58
        });
        if (directSucceeded) {
          this.#setDirectPlaybackHint(directHintKey, true);
          this.#directPlaybackUnsupportedCache.delete(directRetryKey);
          this.#setActiveMediaFile(fileIndex);
          return;
        }
        this.#setDirectPlaybackHint(directHintKey, false);
        this.#directPlaybackUnsupportedCache.add(directRetryKey);
      }

      const transcodeReason = this.#buildTranscodeReason({
        audioCodec: prepared.audioCodec,
        videoCodec: prepared.videoCodec,
        audioSupported: codecSupport.audioSupported,
        videoSupported: codecSupport.videoSupported,
        plannerMode: prepared.mode,
        shouldTranscodeAudio,
        shouldTranscodeVideo
      });
      const statusMessage = shouldTranscodeVideo
        ? Loading.MESSAGES.preparingHlsVideo
        : Loading.MESSAGES.preparingHlsAudio;
      this.setStatus(`${statusMessage}\n${transcodeReason}`);
      const transcodeAudioTrack =
        shouldTranscodeAudio || !this.#canCopyAudioCodecForHls(prepared.audioCodec);
      await this.#playWithProxyTranscode(fileIndex, {
        transport,
        sourceKey: prepared.sourceKey,
        transcodeVideo: shouldTranscodeVideo,
        transcodeAudio: transcodeAudioTrack,
        segmentFormat: this.#requiredSegmentFormat({
          audioCodec: prepared.audioCodec,
          transcodeAudio: transcodeAudioTrack
        }),
        statusMessage: `${statusMessage}\n${transcodeReason}`
      });
      this.#setActiveMediaFile(fileIndex);
      return;
    }

    if (canProbeDirectUrl) {
      const directSucceeded = await this.#tryPlayDirectUrl(prepared.directUrl, {
        statusMessage: Loading.MESSAGES.startingDirectPlayback,
        progress: 70
      });
      if (directSucceeded) {
        this.#setDirectPlaybackHint(directHintKey, true);
        this.#directPlaybackUnsupportedCache.delete(directRetryKey);
        this.#setActiveMediaFile(fileIndex);
        return;
      }
      this.#setDirectPlaybackHint(directHintKey, false);
      this.#directPlaybackUnsupportedCache.add(directRetryKey);
      this.setStatus(Loading.MESSAGES.fallingBackToTranscode);
      try {
        await this.#playWithProxyTranscode(fileIndex, {
          transport,
          sourceKey: prepared.sourceKey,
          transcodeAudio: false
        });
        this.#setActiveMediaFile(fileIndex);
      } catch (transcodeError) {
        if (!this.#isUnsupportedError(transcodeError)) {
          throw transcodeError;
        }
        this.setStatus(Loading.MESSAGES.fallingBackToVideoTranscode);
        try {
          await this.#playWithProxyTranscode(fileIndex, {
            transport,
            sourceKey: prepared.sourceKey,
            transcodeVideo: true,
            transcodeAudio: false
          });
          this.#setActiveMediaFile(fileIndex);
        } catch (fullTranscodeError) {
          if (!this.#isUnsupportedError(fullTranscodeError)) {
            throw fullTranscodeError;
          }
          this.setStatus(Loading.MESSAGES.preparingHlsVideo);
          await this.#playWithProxyTranscode(fileIndex, {
            transport,
            sourceKey: prepared.sourceKey,
            transcodeVideo: true,
            transcodeAudio: true
          });
          this.#setActiveMediaFile(fileIndex);
        }
      }
      return;
    }

    // WebRTC transport: no direct URL probing possible — go straight to HLS transcode.
    const transcodeAudioTrack =
      shouldTranscodeAudio || !this.#canCopyAudioCodecForHls(prepared.audioCodec);
    await this.#playWithProxyTranscode(fileIndex, {
      transport,
      sourceKey: prepared.sourceKey,
      transcodeVideo: shouldTranscodeVideo,
      transcodeAudio: transcodeAudioTrack,
      segmentFormat: this.#requiredSegmentFormat({
        audioCodec: prepared.audioCodec,
        transcodeAudio: transcodeAudioTrack
      })
    });
    this.#setActiveMediaFile(fileIndex);
  }

  /**
   * Return the current open transport, or connect a new proxy and create one.
   * Stores the result in `#proxy` / `#transport` for reuse within the same session.
   *
   * Two-stage connect ("prompt-free first"): the first attempt uses only the
   * proxy's PUBLIC addresses, so the browser never touches the local network
   * and never asks for the local-network permission — a same-LAN viewer then
   * connects through the router's public side when it supports looping the
   * packets back inside (most home routers do). Only when that fails does the
   * flow obtain the permission (explainer + one click that makes the browser
   * ask) and retry with the proxy's local addresses included.
   *
   * @param {{ onConnecting?: (proxyName: string) => void }} [options]
   * @returns {Promise<import("../../domain/proxy-transport.js").ProxyTransport>}
   */
  async #acquireTransport({ onConnecting } = {}) {
    if (this.#transport && (!this.#proxy || this.#proxy.isOpen)) {
      return this.#transport;
    }
    // Close stale proxy if present.
    if (this.#proxy) {
      this.#proxy.close();
      this.#proxy = null;
      this.#transport = null;
    }
    let proxy;
    try {
      // Attempt 1: public addresses only — never triggers the permission
      // question. Shorter timeout: either the public path works within
      // seconds or it never will.
      proxy = await this.#proxySelector.chooseBestProxy({
        allowPrivateCandidates: false,
        connectTimeoutMs: 12_000,
        onConnecting
      });
    } catch (publicOnlyError) {
      this.#throwIfCancelled();
      const lanProbeUrl =
        publicOnlyError instanceof Error && typeof publicOnlyError.lanProbeUrl === "string"
          ? publicOnlyError.lanProbeUrl
          : null;
      this.#logEvt(`public-only connect failed (${publicOnlyError?.message ?? publicOnlyError}); trying local path`);
      await this.#ensureLocalNetworkPermission(lanProbeUrl);
      this.#throwIfCancelled();
      // Attempt 2: all addresses, permission (when the browser has such a
      // mechanism) obtained above.
      proxy = await this.#proxySelector.chooseBestProxy({ allowPrivateCandidates: true, onConnecting });
    }
    return this.#adoptProxy(proxy);
  }

  /**
   * Bind a freshly connected proxy as the active transport: wire the
   * connection-loss handler, remember the connection descriptor for
   * auto-reconnect, and either reuse the existing transport object (swapping
   * its inner proxy in place, so the running HLS loader / torrent-session keep
   * their reference — seamless reconnect) or create one on first connect.
   *
   * @param {import("../../domain/webrtc-proxy.js").WebRtcProxy} proxy
   * @returns {import("../../domain/proxy-transport.js").ProxyTransport}
   */
  #adoptProxy(proxy) {
    // Surface a mid-playback loss of this connection (auto-reconnect flow). A
    // close() by #stopPlayback never fires this.
    proxy.onConnectionLost = () => this.#onTransportLost();
    this.#proxy = proxy;
    if (this.#transport && !this.#transport.isHttp) {
      this.#transport.replaceWebRtcProxy(proxy);
    } else {
      this.#transport = ProxyTransport.fromWebRtc(proxy);
    }
    this.#lastProxyDescriptor = {
      proxyId: proxy.proxyId,
      proxyLocalPort: proxy.proxyLocalPort,
      allowPrivateCandidates: proxy.allowsPrivateCandidates
    };
    return this.#transport;
  }

  /**
   * Make sure the browser lets this page reach the proxy's local address.
   * No-op when the browser has no such permission mechanism (Firefox), or the
   * permission is already granted. Otherwise walks the user through it:
   * an explainer + an "Allow" button whose click performs the local request
   * that makes the browser show its own permission question; a denied state
   * shows guidance and a "Check again" button.
   *
   * @param {string | null} lanProbeUrl - `http://<proxy-lan-ip>:<port>/healthz`, when known.
   * @returns {Promise<void>}
   */
  async #ensureLocalNetworkPermission(lanProbeUrl) {
    for (;;) {
      this.#throwIfCancelled();
      const state = await queryLocalNetworkPermission();
      if (state === "unsupported" || state === "granted") {
        return;
      }
      if (state === "prompt") {
        if (!lanProbeUrl) {
          // Nothing to probe — cannot make the browser ask. Proceed; the
          // attempt itself will succeed or fail on its own.
          return;
        }
        this.setStatus(Loading.MESSAGES.lanPermissionExplainer);
        await this.#waitForActionClick(Loading.MESSAGES.lanAllowButton);
        this.#throwIfCancelled();
        this.setStatus(Loading.MESSAGES.lanPermissionWaiting);
        await probeLocalNetwork(lanProbeUrl);
        continue; // re-check the permission state
      }
      // denied — the browser will not ask again; guide to the site settings.
      this.setStatus(Loading.MESSAGES.lanPermissionDenied);
      await this.#waitForActionClick(Loading.MESSAGES.lanCheckAgainButton);
    }
  }

  /**
   * Show the loading view's action button with `label` and resolve on click.
   * The button is hidden again afterwards. Cancellation (the Cancel button)
   * is honoured: the wait ends and the caller's next #throwIfCancelled throws.
   *
   * @param {string} label
   * @returns {Promise<void>}
   */
  #waitForActionClick(label) {
    return new Promise((resolve) => {
      const button = this.#actionButton;
      button.textContent = label;
      button.hidden = false;
      const cancelPoll = setInterval(() => {
        if (this.#cancelRequested) {
          finish();
        }
      }, 250);
      const onClick = () => finish();
      const finish = () => {
        clearInterval(cancelPoll);
        button.removeEventListener("click", onClick);
        button.hidden = true;
        resolve();
      };
      button.addEventListener("click", onClick);
    });
  }

  /**
   * @param {number} fileIndex
   * @param {{ sourceKey?: string, audioCodec?: string, videoCodec?: string }} prepared
   * @returns {string}
   */
  #buildDirectRetryCacheKey(fileIndex, prepared) {
    const sourceKey = typeof prepared?.sourceKey === "string" ? prepared.sourceKey : "";
    const audioCodec = typeof prepared?.audioCodec === "string" ? prepared.audioCodec : "";
    const videoCodec = typeof prepared?.videoCodec === "string" ? prepared.videoCodec : "";
    return `${sourceKey}:${fileIndex}:${audioCodec}:${videoCodec}`;
  }

  /**
   * @param {{ audioCodec?: string, videoCodec?: string, mode?: string }} prepared
   * @returns {string}
   */
  #buildDirectPlaybackHintKey(prepared) {
    const audioCodec = typeof prepared?.audioCodec === "string" ? prepared.audioCodec : "";
    const videoCodec = typeof prepared?.videoCodec === "string" ? prepared.videoCodec : "";
    const mode = typeof prepared?.mode === "string" ? prepared.mode : "";
    return `${this.#getBrowserProfileKey()}:${audioCodec}:${videoCodec}:${mode}`;
  }

  /**
   * @returns {string}
   */
  #getBrowserProfileKey() {
    const ua = typeof navigator?.userAgent === "string" ? navigator.userAgent : "";
    const platform = typeof navigator?.platform === "string" ? navigator.platform : "unknown-platform";
    const browser = this.#extractBrowserMajor(ua);
    return `${browser}:${platform}`;
  }

  /**
   * @param {string} userAgent
   * @returns {string}
   */
  #extractBrowserMajor(userAgent) {
    const ua = typeof userAgent === "string" ? userAgent : "";
    const patterns = [
      { name: "Edge", regex: /Edg\/(\d+)/ },
      { name: "Chrome", regex: /Chrome\/(\d+)/ },
      { name: "Firefox", regex: /Firefox\/(\d+)/ },
      { name: "Safari", regex: /Version\/(\d+).+Safari/ }
    ];
    for (const pattern of patterns) {
      const match = ua.match(pattern.regex);
      if (match) {
        return `${pattern.name}-${match[1]}`;
      }
    }
    return "Unknown";
  }

  /**
   * @param {string} key
   * @returns {"supported" | "unsupported" | "unknown"}
   */
  #getDirectPlaybackHint(key) {
    const entry = this.#directPlaybackHints.get(key);
    if (!entry || typeof entry !== "object") {
      return "unknown";
    }
    if (Date.now() - entry.updatedAt > DIRECT_PLAYBACK_HINT_TTL_MS) {
      this.#directPlaybackHints.delete(key);
      this.#persistDirectPlaybackHints();
      return "unknown";
    }
    return entry.directSupported === true ? "supported" : "unsupported";
  }

  /**
   * @param {string} key
   * @param {boolean} supported
   */
  #setDirectPlaybackHint(key, supported) {
    this.#directPlaybackHints.set(key, {
      directSupported: supported,
      updatedAt: Date.now()
    });
    this.#trimDirectPlaybackHints();
    this.#persistDirectPlaybackHints();
  }

  #trimDirectPlaybackHints() {
    if (this.#directPlaybackHints.size <= DIRECT_PLAYBACK_HINTS_MAX_ENTRIES) {
      return;
    }
    const sortedEntries = Array.from(this.#directPlaybackHints.entries()).sort(
      (left, right) => left[1].updatedAt - right[1].updatedAt
    );
    const removeCount = sortedEntries.length - DIRECT_PLAYBACK_HINTS_MAX_ENTRIES;
    for (let index = 0; index < removeCount; index += 1) {
      this.#directPlaybackHints.delete(sortedEntries[index][0]);
    }
  }

  #loadDirectPlaybackHints() {
    if (typeof window === "undefined" || !window.localStorage) {
      return;
    }
    try {
      const raw = window.localStorage.getItem(DIRECT_PLAYBACK_HINTS_STORAGE_KEY);
      if (!raw) {
        return;
      }
      const payload = JSON.parse(raw);
      if (!Array.isArray(payload)) {
        return;
      }
      for (const item of payload) {
        if (!Array.isArray(item) || item.length !== 2) {
          continue;
        }
        const [key, value] = item;
        if (typeof key !== "string" || !value || typeof value !== "object") {
          continue;
        }
        const updatedAt = Number(value.updatedAt);
        const directSupported = value.directSupported === true;
        if (!Number.isFinite(updatedAt) || updatedAt <= 0) {
          continue;
        }
        this.#directPlaybackHints.set(key, { updatedAt, directSupported });
      }
      this.#trimDirectPlaybackHints();
    } catch (_error) {
      // Best effort cache; ignore malformed storage.
    }
  }

  #persistDirectPlaybackHints() {
    if (typeof window === "undefined" || !window.localStorage) {
      return;
    }
    try {
      const payload = JSON.stringify(Array.from(this.#directPlaybackHints.entries()));
      window.localStorage.setItem(DIRECT_PLAYBACK_HINTS_STORAGE_KEY, payload);
    } catch (_error) {
      // Best effort cache; ignore storage issues.
    }
  }

  /**
   * @param {string} directUrl
   * @param {{ statusMessage: string, progress: number }} options
   * @returns {Promise<boolean>}
   */
  async #tryPlayDirectUrl(directUrl, options) {
    this.setStatus(options.statusMessage);
    this.setProgress(options.progress);
    await this.#session.playFromUrl(this.#videoElement, directUrl);
    try {
      await this.#ensureVideoReady();
      return true;
    } catch (error) {
      if (!this.#isUnsupportedError(error)) {
        throw error;
      }
      return false;
    }
  }

  /**
   * Remove all subtitle `<track>` elements from the video element and revoke
   * any Blob URLs that were created for them.
   */
  #clearSubtitleTracks() {
    for (const url of this.#subtitleBlobUrls) {
      URL.revokeObjectURL(url);
    }
    this.#subtitleBlobUrls = [];
    if (this.#videoElement instanceof HTMLVideoElement) {
      for (const track of Array.from(this.#videoElement.querySelectorAll("track"))) {
        track.remove();
      }
    }
  }

  /**
   * Find subtitle files that match `fileIndex`, download each one through the
   * proxy transport, convert to WebVTT, and attach as `<track>` elements on the
   * video element.
   *
   * Fire-and-forget — call with `void … .catch(…)`.  Silently skips individual
   * subtitle files that fail to load; throws only on AbortError.
   *
   * No-op when:
   * - No proxy transport is available (webseed-only playback).
   * - No subtitle files were parsed for this torrent.
   * - No subtitle files match the selected video.
   *
   * @param {number} fileIndex
   * @returns {Promise<void>}
   */
  async #loadSubtitlesForVideo(fileIndex) {
    this.#clearSubtitleTracks();

    const transport = this.#transport;
    if (!transport) {
      return; // webseed-only — no proxy to fetch subtitles from
    }
    if (!(this.#videoElement instanceof HTMLVideoElement)) {
      return;
    }

    let sourceKey;
    try {
      sourceKey = await this.#session.registerSourceOnProxy(transport);
    } catch (e) {
      console.warn("[torrent-tv][subtitles] could not obtain sourceKey:", e);
      return;
    }

    const addedExternal = await this.#loadExternalSubtitles(fileIndex, transport, sourceKey);
    await this.#loadEmbeddedSubtitles(fileIndex, transport, sourceKey, { hasDefault: addedExternal });
  }

  /**
   * Read the proxy's detected language from a subtitle response's
   * `X-Subtitle-Language` / `X-Subtitle-Language-Name` headers.
   *
   * @param {{ headers: { get: (name: string) => string | null } }} response
   * @returns {{ code: string, name: string } | null}
   */
  #languageFromHeader(response) {
    const code = response.headers.get("x-subtitle-language");
    if (!code) {
      return null;
    }
    const rawName = response.headers.get("x-subtitle-language-name");
    let name = "";
    if (rawName) {
      try {
        name = decodeURIComponent(rawName);
      } catch {
        name = rawName;
      }
    }
    return { code, name: name || this.#languageName(code) || code };
  }

  /**
   * The film's primary audio-track language, used as a last-resort subtitle
   * language (forced-signs subs usually match the dub) — from the plan probe.
   *
   * @returns {{ code: string, name: string } | null}
   */
  #primaryAudioLanguage() {
    const audio = this.#planTracks?.audio ?? [];
    for (const t of audio) {
      const code = trackLanguageCode(t?.language ?? "");
      if (code && code !== "und") {
        return { code, name: this.#languageName(code) || code };
      }
    }
    return null;
  }

  /** English display name for a language code, or "" when unavailable. */
  #languageName(code) {
    if (!code) {
      return "";
    }
    try {
      return LANGUAGE_DISPLAY?.of(code) ?? "";
    } catch {
      return "";
    }
  }

  /**
   * External subtitle FILES from the torrent (matched to the video by name).
   *
   * @returns {Promise<boolean>} Whether at least one track was attached.
   */
  async #loadExternalSubtitles(fileIndex, transport, sourceKey) {
    if (this.#subtitleFiles.length === 0) {
      return false;
    }
    const files = this.#session.current?.files;
    if (!Array.isArray(files)) {
      return false;
    }
    const videoFile = files[fileIndex];
    if (!videoFile) {
      return false;
    }

    const matched = matchSubtitlesForVideo(videoFile, this.#subtitleFiles);
    if (matched.length === 0) {
      return false;
    }

    let added = false;
    let isFirst = true;
    for (const sub of matched) {
      try {
        // The proxy converts (.srt/.ass → WebVTT), decodes the file's encoding
        // (UTF-8/Windows-1251) and detects the language from the full text,
        // returning it in X-Subtitle-Language. The browser no longer converts.
        const response = await transport.fetch(
          `/api/subtitles?sourceKey=${encodeURIComponent(sourceKey)}&fileIndex=${sub.index}`,
          { signal: this.#session.abortController.signal, timeoutMs: EMBEDDED_SUBTITLE_TIMEOUT_MS }
        );
        if (!response.ok) {
          console.warn(
            `[torrent-tv][subtitles] fetch failed (${response.status}) for`,
            sub.relativePath ?? sub.name
          );
          continue;
        }

        const vtt = await response.text();
        if (!vtt || !vtt.startsWith("WEBVTT")) {
          continue;
        }

        const blob = new Blob([vtt], { type: "text/vtt" });
        const blobUrl = URL.createObjectURL(blob);
        this.#subtitleBlobUrls.push(blobUrl);

        // Language priority: explicit code in the filename (author intent) →
        // proxy content detection (franc) → the film's audio language → und.
        const info = detectSubtitleInfo(sub);
        if (info.code === "und") {
          const detected = this.#languageFromHeader(response) ?? this.#primaryAudioLanguage();
          if (detected) {
            info.code = detected.code;
            info.name = detected.name;
          }
        }
        const label = buildSubtitleLabel(info);

        const track = document.createElement("track");
        track.kind = "subtitles";
        track.label = label;
        track.srclang = info.code;
        track.src = blobUrl;
        if (isFirst) {
          track.default = true;
          isFirst = false;
        }
        this.#videoElement.appendChild(track);
        added = true;
        console.debug(
          `[torrent-tv][subtitles] loaded "${label}" (${info.code}) from`,
          sub.relativePath ?? sub.name
        );
      } catch (e) {
        if (e instanceof DOMException && e.name === "AbortError") {
          throw e;
        }
        console.warn(
          "[torrent-tv][subtitles] error loading",
          sub.relativePath ?? sub.name,
          e
        );
      }
    }
    return added;
  }

  /**
   * Embedded TEXT subtitle tracks (inside the MKV/MP4), extracted by the
   * proxy as WebVTT (`GET /api/subtitles`). Fetched sequentially with a
   * generous timeout: extraction reads the file up to the last cue, so a
   * cold torrent downloads while extracting. Tracks appear in the captions
   * menu as they finish.
   */
  async #loadEmbeddedSubtitles(fileIndex, transport, sourceKey, { hasDefault = false } = {}) {
    const tracks = (this.#planTracks?.subtitles ?? []).filter((t) => t?.textBased === true);
    if (tracks.length === 0) {
      return;
    }
    let defaultTaken = hasDefault;
    for (const track of tracks) {
      try {
        const response = await transport.fetch(
          `/api/subtitles?sourceKey=${encodeURIComponent(sourceKey)}&fileIndex=${fileIndex}&trackIndex=${track.index}`,
          { signal: this.#session.abortController.signal, timeoutMs: EMBEDDED_SUBTITLE_TIMEOUT_MS }
        );
        if (!response.ok) {
          console.warn(`[torrent-tv][subtitles] embedded track ${track.index} fetch failed (${response.status})`);
          continue;
        }
        const vtt = await response.text();
        if (!vtt || !vtt.startsWith("WEBVTT")) {
          continue;
        }
        const blob = new Blob([vtt], { type: "text/vtt" });
        const blobUrl = URL.createObjectURL(blob);
        this.#subtitleBlobUrls.push(blobUrl);

        // Language: container metadata tag (author intent) → proxy content
        // detection (X-Subtitle-Language) → the film's audio language → und.
        let lang = { code: trackLanguageCode(track.language), name: "" };
        if (!lang.code || lang.code === "und") {
          const detected = this.#languageFromHeader(response) ?? this.#primaryAudioLanguage();
          lang = detected ?? { code: "und", name: "" };
        }
        // Prefer the metadata title for the label; else the language name.
        const labelInfo = {
          code: lang.code || "und",
          name: lang.name || this.#languageName(lang.code) || "Unknown",
          group: typeof track.title === "string" && track.title.trim() ? track.title.trim() : null
        };

        const el = document.createElement("track");
        el.kind = "subtitles";
        el.label = buildSubtitleLabel(labelInfo);
        el.srclang = lang.code || "und";
        el.src = blobUrl;
        if (!defaultTaken && track.isDefault === true) {
          el.default = true;
          defaultTaken = true;
        }
        this.#videoElement.appendChild(el);
        console.debug(`[torrent-tv][subtitles] embedded track loaded "${el.label}"`);
      } catch (e) {
        if (this.#isAbortError(e)) {
          throw e;
        }
        console.warn(`[torrent-tv][subtitles] embedded track ${track.index} failed:`, e);
      }
    }
  }

  /**
   * @param {number} fileIndex
   */
  #setActiveMediaFile(fileIndex) {
    this.#activeFileIndex = Number.isInteger(fileIndex) ? fileIndex : -1;
    document.dispatchEvent(
      new CustomEvent(PLAYER_EVENTS.SET_ACTIVE_MEDIA_FILE, {
        detail: { fileIndex }
      })
    );
    // A shareable link for what's playing (the address bar cleaned the source
    // param on load). Same source for every file of the torrent.
    document.dispatchEvent(
      new CustomEvent(PLAYER_EVENTS.SET_SHARE_LINK, {
        detail: { url: this.#buildShareUrl() }
      })
    );
    // Feed the player's audio menu with the active file's tracks.
    const audioTracks = (this.#planTracks?.audio ?? []).map((t) => ({
      index: t.index,
      label: buildTrackLabel(t)
    }));
    document.dispatchEvent(
      new CustomEvent(PLAYER_EVENTS.SET_AUDIO_TRACKS, {
        detail: { tracks: audioTracks, activeIndex: this.#selectedAudioTrackIndex }
      })
    );
    // What automatic quality has settled on, as far as is known BEFORE the
    // first progress report. When the video is copied the answer is final —
    // nothing is being re-encoded, so what plays is the source's own height,
    // and it came with the plan. When it is re-encoded this is the ceiling and
    // the first report may lower it. Without this the menu's first render
    // always read a bare "Auto" and only gained its height a second or two
    // later, on the first poll that carried one; a viewer who opened the menu
    // in that window was told nothing.
    if (this.#autoEffectiveHeight === 0 && !this.#videoIsReencoded && this.#sourceVideoHeight > 0) {
      this.#autoEffectiveHeight = this.#sourceVideoHeight;
    }
    // Feed the player's quality menu — the stream's own variants where it has
    // them, otherwise Auto plus forced resolutions at or below the source.
    this.#publishQualityOptions();
  }

  /**
   * The viewer picked a quality.
   *
   * Where the stream has variants the player switches between them itself: it
   * fetches the other variant, appends it after what is already buffered and
   * changes the decoder's type if the codec parameters differ — playback never
   * stops. Where it has none (a copied video, or a source with nothing to step
   * down to) the only way to change resolution is still to re-open the session
   * at a fixed size, which costs a cold start with the picture gone.
   *
   * @param {CustomEvent} event
   */
  #onSelectQuality = (event) => {
    const detail = event instanceof CustomEvent ? event.detail : null;
    const height = Number(detail?.height);
    if (!Number.isInteger(height) || height < 0) {
      return;
    }
    const level = this.#hlsPlayer.levels().find((candidate) => candidate.height === height);
    if (level) {
      if (level.index === this.#hlsPlayer.currentLevel()) {
        return;
      }
      void this.#switchQualityLevel(level, height);
      return;
    }
    if (height === this.#selectedQualityHeight) {
      return;
    }
    if (this.#isProcessing || this.#activeFileIndex < 0 || !this.#session.current) {
      return;
    }
    const fileIndex = this.#activeFileIndex;
    const position =
      this.#videoElement instanceof HTMLVideoElement && Number.isFinite(this.#videoElement.currentTime)
        ? this.#videoElement.currentTime
        : 0;
    this.#selectedQualityHeight = height;
    document.dispatchEvent(
      new CustomEvent(LOADING_EVENTS.SHOW, {
        detail: { status: Loading.MESSAGES.switchingQuality, progress: 0 }
      })
    );
    const epoch = this.#beginPlaybackAttempt();
    void this.#switchToVideoFile(fileIndex)
      .then(() => {
        if (position > 1 && this.#videoElement instanceof HTMLVideoElement) {
          this.#videoElement.currentTime = position;
        }
      })
      .catch((error) => {
        if (this.#isAbortError(error)) {
          return;
        }
        const message = error instanceof Error ? error.message : String(error);
        console.error("[torrent-tv] quality switch failed:", message, error);
        this.#failPlayback(epoch, { description: message });
      });
  };

  /**
   * Move the player to another quality rung, having first asked the proxy to
   * make one ready.
   *
   * The rung does not exist until it is asked for: its encoder starts from
   * nothing and its first segment takes as long as it takes — 15 988 ms
   * measured on 2026-08-11. Switching first and waiting second puts that wait
   * on screen as a spinner. Asking first puts it behind the picture that is
   * still playing, and the switch happens when there is something to switch to.
   *
   * The wait is not allowed to be indefinite: a rung that is not ready in time
   * is still switched to, because the viewer asked for it and waiting is what
   * they would have done anyway.
   *
   * @param {{ index: number, height: number }} level
   * @param {number} height
   * @returns {Promise<void>}
   */
  async #switchQualityLevel(level, height) {
    // Remembered up front: it is what the NEXT file of this torrent opens at,
    // and that is true whether or not this switch turns out to be quick.
    this.#selectedQualityHeight = height;
    // Which pick this is. Warming waits on the proxy, so two picks in quick
    // succession are two waits that finish in whatever order the rungs happen
    // to be ready — and without this the one that finishes LAST wins, which is
    // not the one the viewer made last. A rung that was already warm answers in
    // a second while a cold one takes thirty, so the older pick would routinely
    // land on top and move the picture back on its own.
    const pick = (this.#qualityPickSeq ?? 0) + 1;
    this.#qualityPickSeq = pick;
    const position =
      this.#videoElement instanceof HTMLVideoElement && Number.isFinite(this.#videoElement.currentTime)
        ? this.#videoElement.currentTime
        : 0;
    this.#logEvt(`quality: preparing ${height}p at ${Math.round(position)}s before switching`);
    const ready = await this.#session.prepareQualityVariant(height, position);
    if (this.#qualityPickSeq !== pick) {
      this.#logEvt(`quality: ${height}p was superseded by a later pick; not switching`);
      return;
    }
    this.#logEvt(
      ready
        ? `quality: ${height}p is ready, switching`
        : `quality: ${height}p is not ready yet, switching anyway`
    );
    if (!this.#hlsPlayer.switchLevel(level.index)) {
      this.#logEvt(`quality: the player refused the switch to ${height}p`);
    }
  }

  /**
   * The viewer picked another audio track: replay the active file through
   * the remux/transcode path with `-map 0:a:N`, preserving the position.
   *
   * @param {CustomEvent} event
   */
  #onSelectAudioTrack = (event) => {
    const detail = event instanceof CustomEvent ? event.detail : null;
    const trackIndex = Number(detail?.trackIndex);
    if (!Number.isInteger(trackIndex) || trackIndex < 0) {
      return;
    }
    if (trackIndex === this.#selectedAudioTrackIndex) {
      return;
    }
    if (this.#isProcessing || this.#activeFileIndex < 0 || !this.#session.current) {
      return;
    }
    const fileIndex = this.#activeFileIndex;
    const position =
      this.#videoElement instanceof HTMLVideoElement && Number.isFinite(this.#videoElement.currentTime)
        ? this.#videoElement.currentTime
        : 0;
    this.#selectedAudioTrackIndex = trackIndex;
    document.dispatchEvent(
      new CustomEvent(LOADING_EVENTS.SHOW, {
        detail: { status: Loading.MESSAGES.switchingAudio, progress: 0 }
      })
    );
    const epoch = this.#beginPlaybackAttempt();
    void this.#switchToVideoFile(fileIndex)
      .then(() => {
        if (position > 1 && this.#videoElement instanceof HTMLVideoElement) {
          this.#videoElement.currentTime = position;
        }
      })
      .catch((error) => {
        if (this.#isAbortError(error)) {
          return;
        }
        const message = error instanceof Error ? error.message : String(error);
        console.error("[torrent-tv] audio switch failed:", message, error);
        this.#failPlayback(epoch, { description: message });
      });
  };

  /**
   * The proxy connection died after being established (not closed by us).
   * With a file playing, capture everything recovery needs BEFORE anything
   * clears the session, then start the automatic reconnect loop. While a
   * loading flow is in flight its own failure path reports instead.
   *
   * @returns {void}
   */
  #onTransportLost() {
    this.#logEvt("transport lost (data channel closed/failed)");
    if (this.#isProcessing) {
      return;
    }
    const current = this.#session.current;
    if (!current || this.#activeFileIndex < 0) {
      return;
    }
    // A fresh loss invalidates any pending "playback is stable" reset, so a
    // quick relapse still counts toward the cycle guard.
    if (this.#stableTimer !== null) {
      clearTimeout(this.#stableTimer);
      this.#stableTimer = null;
    }
    const position =
      this.#videoElement instanceof HTMLVideoElement && Number.isFinite(this.#videoElement.currentTime)
        ? this.#videoElement.currentTime
        : 0;
    const resume = {
      fileIndex: this.#activeFileIndex,
      positionSeconds: position,
      sessionCurrent: current
    };
    this.#resumeState = resume;
    void this.#autoReconnect(resume);
  }

  /**
   * Automatic recovery ladder (see the auto-reconnect OpenSpec change):
   * - Level 1 (seamless): keep the player running from its buffer, rebuild
   *   the connection to the SAME proxy, swap the transport underneath and
   *   resume fetching — no visible interruption.
   * - Level 2 (rebuild): re-select (possibly a different proxy) and replay
   *   the file-switch flow with a server-side seek to the captured position.
   * - Level 3 (manual): the error screen with Retry, only after all attempts
   *   fail. #resumeState stays set so manual Retry still works.
   *
   * Never throws (called from an event callback); cancellation ends it
   * silently. Every attempt is logged on the [torrent-tv] channel.
   *
   * @param {{ fileIndex: number, positionSeconds: number, sessionCurrent: object }} resume
   * @returns {Promise<void>}
   */
  async #autoReconnect(resume) {
    this.#reconnectCycles += 1;
    if (this.#reconnectCycles > RECONNECT_MAX_CYCLES) {
      console.debug(`[torrent-tv] reconnect: giving up after ${RECONNECT_MAX_CYCLES} cycles`);
      this.#dispatchConnectionLost();
      return;
    }

    // Freeze fetching but keep the player and its buffer alive (Level 1). Keep
    // the transport OBJECT (swap target); only drop the dead proxy.
    try { this.#hlsPlayer.stopLoad(); } catch { /* best-effort */ }
    try { this.#proxy?.close(); } catch { /* best-effort */ }
    this.#proxy = null;

    // Seamless is only possible over a live hls.js WebRTC transport with a
    // known proxy to dial back.
    let seamlessPossible =
      !!this.#lastProxyDescriptor &&
      !!this.#transport &&
      !this.#transport.isHttp &&
      this.#hlsPlayer.isActive();
    let overlayShown = false;
    const showOverlay = () => {
      if (!overlayShown) {
        document.dispatchEvent(
          new CustomEvent(LOADING_EVENTS.SHOW, {
            detail: { status: Loading.MESSAGES.reconnecting, progress: 0 }
          })
        );
        overlayShown = true;
      }
    };

    for (let attempt = 1; attempt <= RECONNECT_TOTAL_ATTEMPTS; attempt += 1) {
      if (this.#cancelRequested) {
        return;
      }
      if (attempt === 2) {
        await this.#sleep(RECONNECT_BACKOFF_MS);
      }
      if (typeof navigator === "object" && navigator.onLine === false) {
        if (overlayShown) {
          this.setStatus(Loading.MESSAGES.waitingForNetwork);
        }
        await this.#waitForOnline(RECONNECT_ONLINE_WAIT_MS);
        if (this.#cancelRequested) {
          return;
        }
      }
      const sameProxy = seamlessPossible && attempt <= RECONNECT_SAME_PROXY_ATTEMPTS;
      console.debug(
        `[torrent-tv] reconnect attempt ${attempt}/${RECONNECT_TOTAL_ATTEMPTS} ` +
          (sameProxy ? "(same proxy, seamless)" : "(reselect, rebuild)")
      );
      try {
        if (sameProxy) {
          const proxy = await this.#proxySelector.reconnectTo(this.#lastProxyDescriptor, {
            connectTimeoutMs: RECONNECT_CONNECT_TIMEOUT_MS
          });
          this.#adoptProxy(proxy); // swaps the inner proxy under the live player
          // Liveness + session-exists probe over the NEW channel (routes
          // through the swapped transport). Non-null → the warm transcode
          // session is still there; resume fetching seamlessly.
          const progress = await this.#session.fetchActiveTranscodeProgress();
          if (progress) {
            this.#hlsPlayer.startLoad();
            console.debug("[torrent-tv] reconnect: seamless resume");
            this.#armStabilityTimer();
            return;
          }
          // Channel is good but the transcode session expired — rebuild
          // playback on this (already connected) proxy; no need to re-select.
          console.debug("[torrent-tv] reconnect: transcode session gone, rebuilding on the new channel");
          showOverlay();
          await this.#resumePlayback(resume);
          this.#armStabilityTimer();
          return;
        }

        // Level 2 rebuild: drop the dead transport and acquire a fresh one
        // (standard two-stage flow — may walk the permission UI), then replay
        // the file with a server-side seek.
        showOverlay();
        this.#transport = null;
        await this.#acquireTransport();
        await this.#resumePlayback(resume);
        this.#armStabilityTimer();
        return;
      } catch (error) {
        if (this.#isAbortError(error) || this.#cancelRequested) {
          return;
        }
        const message = error instanceof Error ? error.message : String(error);
        console.debug(`[torrent-tv] reconnect attempt ${attempt} failed: ${message}`);
      }
    }

    this.#dispatchConnectionLost();
  }

  /**
   * Restore the session snapshot and replay the file-switch flow, seeking back
   * to the captured position (the seek rides the server-side seek machinery).
   * Shared by the automatic rebuild and the manual Retry so the two paths
   * cannot drift. Rejects on failure so the caller decides how to surface it.
   *
   * @param {{ fileIndex: number, positionSeconds: number, sessionCurrent: object }} resume
   * @returns {Promise<void>}
   */
  async #resumePlayback(resume) {
    this.#cancelRequested = false;
    this.#session.current = resume.sessionCurrent;
    // Announced BEFORE the load, so it travels the same path a resume from the
    // address does: hls.js begins buffering there and the proxy is told to
    // encode from there. Setting `currentTime` after the reveal instead meant
    // loading the film from the beginning, showing it, and only then seeking —
    // a second wait for something the viewer had already waited through.
    this.#pendingCurrentTime = resume.positionSeconds > 1 ? resume.positionSeconds : null;
    await this.#switchToVideoFile(resume.fileIndex);
  }

  /**
   * Show the recoverable connection-lost error screen (Level 3 fallback).
   * #resumeState is left intact so the manual Retry can still resume.
   *
   * @returns {void}
   */
  #dispatchConnectionLost() {
    document.dispatchEvent(
      new CustomEvent(LOADING_EVENTS.PLAYBACK_FAILED, {
        detail: { description: Loading.MESSAGES.connectionLost, canRetry: true }
      })
    );
  }

  /**
   * Arm the "playback has stabilised" timer: once playback survives
   * {@link RECONNECT_STABLE_RESET_MS}, reset the consecutive-cycle counter so a
   * later, unrelated loss gets the full set of attempts again.
   *
   * @returns {void}
   */
  #armStabilityTimer() {
    if (this.#stableTimer !== null) {
      clearTimeout(this.#stableTimer);
    }
    this.#stableTimer = setTimeout(() => {
      this.#reconnectCycles = 0;
      this.#stableTimer = null;
    }, RECONNECT_STABLE_RESET_MS);
  }

  /**
   * @param {number} ms
   * @returns {Promise<void>}
   */
  #sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Resolve when the browser regains connectivity (`online` event) or after
   * `timeoutMs`, whichever comes first. Also polls #cancelRequested so a
   * cancel during the wait ends it promptly.
   *
   * @param {number} timeoutMs
   * @returns {Promise<void>}
   */
  #waitForOnline(timeoutMs) {
    return new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        clearInterval(poll);
        window.removeEventListener("online", finish);
        resolve();
      };
      const timer = setTimeout(finish, timeoutMs);
      const poll = setInterval(() => {
        if (this.#cancelRequested || (typeof navigator === "object" && navigator.onLine === true)) {
          finish();
        }
      }, 250);
      window.addEventListener("online", finish);
    });
  }

  /**
   * Retry after a lost connection (manual, from the error screen). Delegates
   * to the shared resume path; the proxy is re-selected by the normal flow.
   */
  #onRetryPlayback = () => {
    const resume = this.#resumeState;
    this.#resumeState = null;
    if (!resume || !resume.sessionCurrent) {
      return;
    }
    document.dispatchEvent(
      new CustomEvent(LOADING_EVENTS.SHOW, {
        detail: { status: Loading.MESSAGES.reconnecting, progress: 0 }
      })
    );
    // A manual retry starts a fresh connection — do not reuse the dead one.
    this.#transport = null;
    const epoch = this.#beginPlaybackAttempt();
    void this.#resumePlayback(resume).catch((error) => {
      if (this.#isAbortError(error)) {
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      console.error("[torrent-tv] retry failed:", message, error);
      this.#failPlayback(epoch, { description: message, canRetry: error?.canRetry === true });
    });
  };

  /**
   * @param {number} fileIndex
   * @param {{
   *   transport?: import("../../domain/proxy-transport.js").ProxyTransport,
   *   sourceKey?: string,
   *   transcodeVideo?: boolean,
   *   transcodeAudio?: boolean,
   *   statusMessage?: string
   * }} [options]
   * @returns {Promise<void>}
   */
  async #playWithProxyTranscode(fileIndex, options = {}) {
    this.#throwIfCancelled();
    // Which tracks this session re-encodes. A copied track has no encoder and
    // therefore no line on the waiting overlay; both copied means no encoder
    // line at all, which is the truth about a direct-play session.
    this.#encodingTracks = {
      video: options.transcodeVideo === true,
      audio: options.transcodeAudio !== false
    };
    let transport = options.transport ?? this.#transport ?? null;
    if (!transport) {
      transport = await this.#acquireTransport();
    }
    if (!transport) {
      throw new Error(Loading.MESSAGES.noProxyAndNoWebseed);
    }
    this.setStatus(
      typeof options.statusMessage === "string" && options.statusMessage.trim().length > 0
        ? options.statusMessage
        : Loading.MESSAGES.preparingHls
    );
    this.#setPhaseProgress(1, 0); // entering phase 1 (transcode first segment)

    // For WebRTC transport, HLS.js must route all requests through the data
    // channel. The loader takes the transport (not the raw proxy) so a seamless
    // reconnect (transport.replaceWebRtcProxy) redirects segment loads with no
    // player rebuild.
    const hlsLoader = !transport.isHttp
      ? createWebRtcHlsLoader(transport)
      : undefined;

    // Resuming: the transcode AND the pre-buffer begin AT the target position,
    // so there is a SINGLE loading at the resume point. Loading from 0 and
    // seeking after the reveal showed a second loading screen.
    //
    // BOTH sides have to be told. hls.js gets it as `startPosition`, and the
    // proxy gets it as the position to encode from — this used to rely on the
    // proxy inferring a seek from a far segment request, which it deliberately
    // no longer does: a request steers nothing, and every restart comes from a
    // position the viewer stated. With only hls.js told, a refresh at 1:17:10
    // asked for segment #446 while the encoder was told to start at #0; the
    // request was held for 45 s, answered 404, and the viewer got "no data
    // arrived from the proxy" (field 2026-08-06).
    // One-shot: consumed here so the post-reveal #applyPendingResume does not
    // seek a second time.
    // Where to begin. The field is filled by whichever path opened this file,
    // and it LOSES A RACE: measured 2026-08-06, the position arrived with an
    // event that fires after the session has been created, so this read saw
    // null, the proxy was told `start=0s`, the film loaded from the beginning,
    // and the position was then applied as an ordinary seek once the player was
    // already on screen — a cold start and an encoder restart for something
    // that was known all along.
    //
    // The address bar does not race. It is written before the load begins, it
    // survives a reload, and it is the state by design, so it is consulted
    // whenever the field is empty.
    const fromField = this.#pendingCurrentTime;
    this.#pendingCurrentTime = null;
    // The address bar's position belongs to the file it was written for, and at
    // this moment it still describes the PREVIOUS one: the address is rewritten
    // from `#activeFileIndex`, which does not become this file until the load
    // finishes. Taking it regardless is why picking the next episode started it
    // wherever the last one had got to — field-reported 2026-08-11, and the
    // further into an episode the viewer was, the further into the next one it
    // began.
    const urlState = readUrlState(location.search);
    const urlIsForThisFile = urlState.fileIndex === fileIndex;
    const fromUrl = resumePositionFor(urlState, fileIndex);
    const resumeStartPosition = fromField != null && fromField > 0
      ? fromField
      : (fromUrl > 0 ? fromUrl : null);
    // Said out loud because the two sides have disagreed about it twice: the
    // position reached hls.js, which duly asked for segment #127, while the
    // proxy was told to start at zero and the viewer waited 45.6 s for a
    // segment nobody was making. Whoever drops it, this line and the proxy's
    // matching `start=` name the moment between them.
    this.#logEvt(
      `starting from ${resumeStartPosition == null ? "the beginning" : `${Math.round(resumeStartPosition)}s`}` +
      ` (field=${fromField == null ? "-" : Math.round(fromField)}` +
      ` url=${fromUrl > 0 ? Math.round(fromUrl) : "-"}` +
      `${urlIsForThisFile ? "" : ` [address bar still describes file ${urlState.fileIndex}, ignored]`})`
    );
    // Held so the `playing` handler can say how far the actual start fell from
    // what was asked for.
    this.#resumeAskedFor = typeof resumeStartPosition === "number" && resumeStartPosition > 0
      ? resumeStartPosition
      : null;

    await this.#session.streamFileToVideoWithAudioTranscode(fileIndex, this.#videoElement, {
      transport,
      sourceKey: typeof options.sourceKey === "string" ? options.sourceKey : "",
      transcodeVideo: options.transcodeVideo === true,
      transcodeAudio: options.transcodeAudio === true,
      segmentFormat: typeof options.segmentFormat === "string" ? options.segmentFormat : "",
      audioTrackIndex: this.#selectedAudioTrackIndex,
      startPositionSeconds:
        typeof resumeStartPosition === "number" && resumeStartPosition > 0 ? resumeStartPosition : 0,
      ...this.#buildQualityTargetConfig(options.transcodeVideo === true),
      playHls: (videoElement, manifestUrl, playOptions = {}) =>
        this.#hlsPlayer.play(videoElement, manifestUrl, {
          ...(hlsLoader ? { loader: hlsLoader } : {}),
          ...(typeof resumeStartPosition === "number" && resumeStartPosition > 0
            ? { startPosition: resumeStartPosition }
            : {}),
          onLevelSwitched: (height) => this.#onHlsLevelSwitched(height),
          ...playOptions
        }),
      onTranscodeProgress: (progress) => this.#renderTranscodeProgress(progress)
    });
    // The variants are known only once the manifest has been parsed, which
    // happens inside the call above. The menu was published before it, from the
    // source's height alone.
    this.#publishQualityOptions();
    // Transcoded HLS is always browser-compatible (proxy outputs H.264/AAC), so
    // a codec-decodability check is unnecessary. More importantly, waiting for a
    // presented frame here deadlocks on iOS because the player view is still
    // occluded by the modal loading dialog (see #ensureVideoReady).
    //
    // Keep the status moving while the FIRST segment is produced and buffered:
    // waitForHlsPlaylist returns immediately for the synthetic VOD playlist, so
    // its progress polling stops here — poll the session directly until the
    // player is ready.
    // Phase 1 — first segment production: the progress poll writes the loading
    // status ("Preparing first segment… / ETA").
    const stopProgressPoll = this.#startTranscodeProgressPoll();
    try {
      await this.#ensureVideoReady({ requireDecodedFrame: false });
    } finally {
      // Stop the poll BEFORE pre-buffering, so only #waitForPrebuffer writes the
      // status during the cushion fill. Otherwise both write it (poll every ~1 s,
      // pre-buffer every 250 ms) and the text flickers between "ETA…" and
      // "Buffering…".
      stopProgressPoll();
    }
    // Phase 2 — pre-buffer: don't reveal the player until a cushion of video is
    // buffered ahead, so a transient production/delivery dip right after start
    // doesn't immediately stall. The video stays paused (player hidden) so hls.js
    // fills the buffer without draining it; #waitForPrebuffer is the only status
    // writer here.
    await this.#waitForPrebuffer(this.#videoElement, PREBUFFER_TIMEOUT_MS);
  }

  /**
   * Wall-clock span currently covered by the buffer-fill rolling window (see
   * #trackBufferFillRate) — read-only, pushes no sample. Used by
   * #waitForPrebuffer to require the FULL window before trusting the rate for
   * an EARLY start, not just the shorter minimum span that makes the rate
   * trustworthy at all (see BUFFER_FILL_MIN_SPAN_MS vs BUFFER_FILL_WINDOW_MS).
   *
   * @returns {number} Milliseconds; 0 if fewer than 2 samples exist yet.
   */
  #bufferFillSpanMs() {
    const samples = this.#bufferFillSamples;
    return samples.length < 2 ? 0 : Date.now() - samples[0].at;
  }

  /**
   * Wait until enough video is buffered ahead before revealing the player.
   *
   * The cushion target and the fill-rate measurement are the SAME ones
   * #computeUnifiedEta uses for the displayed percent/ETA (#adaptiveCushionTarget,
   * #trackBufferFillRate) — this function calls #computeUnifiedEta itself each
   * tick rather than recomputing them, so the reveal gate and the number shown
   * to the viewer can never disagree about what "ready" means. Also fetches the
   * SAME live transcode progress the mid-playback buffering pill polls
   * (#session.fetchActiveTranscodeProgress), at the same ~1.5s cadence, and
   * renders it through the SAME formatter (#formatBufferingText) — so the text
   * is identical in format and in data source across first-open, this pre-
   * buffer tail, and a later seek, not three independent approximations of the
   * same question.
   *
   * Falls back to an absolute `timeoutMs` so a slow encoder never blocks
   * playback forever.
   *
   * @param {HTMLVideoElement} videoElement
   * @param {number} timeoutMs
   * @returns {Promise<void>}
   */
  async #waitForPrebuffer(videoElement, timeoutMs) {
    if (!(videoElement instanceof HTMLVideoElement)) {
      return;
    }
    // Cold-start: prebuffer entry ≈ "prepare done" (t3). t4 is a successful
    // return below.
    if (this.#coldStart) {
      this.#coldStart.t3 = performance.now();
    }
    // The player is hidden during pre-buffer, so the video MUST stay paused.
    // If it plays here it drains the buffer, so `ahead` never reaches the
    // target — the loading screen sticks while audio is heard. The player starts
    // playback when the machine reaches ADVANCING.
    if (!videoElement.paused) {
      this.#logEvt("player.pause reason=prebuffer");
      // Ours, not the viewer's — see domain/playback-intent.js. Read as the
      // viewer's, this single line ended every cold open stopped on its first
      // frame.
      pauseWithoutIntent(videoElement);
    }
    const startedAt = Date.now();
    let loggedTarget = -1;
    let cachedProgress = null;
    let lastProgressFetchAt = 0;
    while (Date.now() - startedAt < timeoutMs) {
      this.#throwIfCancelled();
      if (videoElement.error) {
        return;
      }
      // Re-assert pause in case leftover play-intent resumed it.
      if (!videoElement.paused) {
        videoElement.pause();
      }
      const now = Date.now();
      if (now - lastProgressFetchAt >= 1500) {
        lastProgressFetchAt = now;
        try {
          cachedProgress = await this.#session.fetchActiveTranscodeProgress();
        } catch {
          // Transient — keep the last known progress rather than blanking it.
        }
      }
      // The published reading, not a fresh one of our own — see the listener.
      const ahead = this.#lastBufferedAhead ?? bufferedAheadSeconds(videoElement);
      const unified = this.#waitingModel.update({
        bufferedAhead: ahead,
        fillRate: this.#lastFillRate ?? undefined,
        downloadStats: this.#lastDownloadStats,
        transcodeProgress: cachedProgress
      });
      const fillRate = unified.fillRate;
      // The model owns this figure now: the gate releases on it and the estimate
      // counts down to it, so they cannot describe different moments.
      this.#waitingModel.update({ fillRate: Number.isFinite(fillRate) ? fillRate : undefined });
      // THE gate rule lives in the model, in one copy. It was written here as
      // well, with its own thresholds, and two copies of one rule can only be
      // tested against themselves — while they were separate the overlay
      // announced the cushion met on a wait that then ran 42.6 s.
      const gate = this.#waitingModel.mayStartPlayback({
        ahead,
        fillRate,
        fillSpanMs: this.#bufferFillSpanMs()
      });
      const target = gate.target;

      if (gate.ready) {
        this.#logEvt(
          `prebuffer ready start=${gate.reason} ` +
            `ahead=${ahead.toFixed(1)}s target=${target.toFixed(1)}s ` +
            `fillRate=${Number.isFinite(fillRate) ? fillRate.toFixed(2) : "n/a"}`
        );
        this.#logColdStart();
        return;
      }
      if (Math.round(target) !== loggedTarget) {
        loggedTarget = Math.round(target);
        this.#logEvt(
          `prebuffer target=${loggedTarget}s ahead=${ahead.toFixed(1)}s ` +
            `fillRate=${Number.isFinite(fillRate) ? fillRate.toFixed(2) : "n/a"}`
        );
      }
      this.#setPhaseProgress(2, unified.cushionPercent ?? 0); // phase 2 (buffering) fills the final third
      // Renders on its own — its return value must NOT be fed back through
      // setStatus. Doing that stored the finished text as the STEP, and the
      // next render appended the supply, readiness and time rows to it: exactly
      // three rows per pass, measured 2026-08-09 growing 21 rows/771 chars to
      // 24/830 to 27/… until the line ran off the screen.
      // Published, not drawn: the overlay keeps its own model and renders from
      // these facts. This used to call the formatter directly, which is how a
      // component that no longer talks to the overlay went on computing text
      // nobody read.
      document.dispatchEvent(new CustomEvent(PROXY_EVENTS.MEASURED, {
        detail: { downloadStats: this.#lastDownloadStats, transcodeProgress: cachedProgress }
      }));
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    // Timed out. If NOTHING buffered, the stream never started (dead transport /
    // segments never arriving — e.g. a WebRTC connection blocked by the Local
    // Network Access gate). Fail loudly instead of revealing a dead player:
    // proceeding would fire PLAYBACK_READY over an element that can never play.
    const finalAhead = bufferedAheadSeconds(videoElement);
    this.#logEvt(`prebuffer timeout ahead=${finalAhead.toFixed(1)}s`);
    if (finalAhead < PREBUFFER_MIN_START_SECONDS) {
      throw new Error(Loading.MESSAGES.prebufferStalled);
    }
    // Proceeding into playback despite the timeout — still a (degraded) start.
    this.#logColdStart();
  }

  /**
   * Log the one-line cold-start summary for the proxy-served flow, then clear
   * the marks. No-op unless all phase marks were captured (a direct/webseed
   * start, or a partially-instrumented path, logs nothing rather than NaN).
   *
   * @returns {void}
   */
  #logColdStart() {
    const c = this.#coldStart;
    this.#coldStart = null;
    if (!c || ![c.t0, c.t1, c.t2, c.t3].every((v) => typeof v === "number")) {
      return;
    }
    const t4 = performance.now();
    this.#logEvt(
      `cold-start total=${Math.round(t4 - c.t0)}ms ` +
        `transport=${Math.round(c.t1 - c.t0)}ms plan=${Math.round(c.t2 - c.t1)}ms ` +
        `prepare=${Math.round(c.t3 - c.t2)}ms prebuffer=${Math.round(t4 - c.t3)}ms`
    );
  }

  /**
   * Emit a timestamped `[evt]` diagnostic line (UTC, same zone as the proxy
   * logger) for correlation. Temporary.
   *
   * @param {string} message
   * @returns {void}
   */
  #logEvt(message) {
    console.debug(`[evt] ${new Date().toISOString().slice(11, 23)} ${message}`);
  }


  /**
   * Poll the active transcode session's progress every second and render it,
   * until the returned stop function is called. Used to keep the loading status
   * moving while the first segment is produced/buffered after the playlist is
   * already available.
   *
   * @returns {() => void} Stop function.
   */
  #startTranscodeProgressPoll() {
    let stopped = false;
    const tick = async () => {
      while (!stopped) {
        try {
          const progress = await this.#session.fetchActiveTranscodeProgress();
          if (!stopped && progress) {
            this.#renderTranscodeProgress(progress);
          }
        } catch (_error) {
          // Transient errors (session not ready yet) are ignored.
        }
        if (stopped) {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    };
    void tick();
    return () => {
      stopped = true;
    };
  }

  /**
   * Render loading status for the transcode stage — the only thing the player
   * waits for before playback starts. Shows transcoder warmup while ffmpeg
   * spins up, then the SAME cushion percent / cushion-remaining-seconds /
   * unified "time to playback" estimate the mid-playback buffering pill shows
   * (#computeUnifiedEta) — not a separate,
   * narrower "just the first 4s segment" calculation, which used to disagree
   * with what the buffering pill shows for the exact same session (field-
   * reported: this screen was never migrated when the pill moved off the
   * whole-file percent onto the cushion figures). Used both by the warmup
   * polling inside the transcode session and by #startTranscodeProgressPoll.
   *
   * @param {object | null} progress
   * @returns {void}
   */
  #renderTranscodeProgress(progress) {
    if (!progress || typeof progress !== "object") {
      return;
    }
    const warmupPercent =
      typeof progress.warmupPercent === "number" ? progress.warmupPercent : NaN;

    // The live download stats captured by the stats poll, so this screen feeds
    // #formatBufferingText the SAME two-stage input a mid-playback seek does —
    // the supply line must not vanish here just because a transcode session
    // now exists (field-reported: the first-open screen and the seek overlay
    // showed different information for the same underlying state).
    const unified = this.#waitingModel.update({
      bufferedAhead: bufferedAheadSeconds(this.#videoElement),
      fillRate: this.#lastFillRate ?? undefined,
      downloadStats: this.#lastDownloadStats,
      transcodeProgress: progress
    });
    // Phase 1 fills its third by the SAME cushion % every other surface uses.
    this.#setPhaseProgress(1, unified.cushionPercent ?? 0);

    // Before ffmpeg has produced anything there is no cushion to report, so name
    // what IS happening — the transcoder starting — rather than leaving the
    // screen silent about it. The STEP only: the rest of the block renders
    // itself, and feeding its rendered output back in here is what grew the
    // line by two rows a pass until it ran off the screen. Third occurrence of
    // that fault, so the render now returns nothing and there cannot be a
    // fourth.
    if (Number.isFinite(warmupPercent) && (unified.cushionPercent ?? 0) <= 0) {
      this.#stageFromPipeline = true;
      this.setStatus(`Starting transcoder... ${Math.round(warmupPercent)}%`);
    }
    document.dispatchEvent(new CustomEvent(PROXY_EVENTS.MEASURED, {
      detail: { downloadStats: this.#lastDownloadStats, transcodeProgress: progress }
    }));
  }


  /**
   * @param {{ requireDecodedFrame?: boolean }} [options]
   *   When `requireDecodedFrame` is false, readiness is satisfied once metadata
   *   and non-zero dimensions are known, without waiting for a *presented*
   *   video frame. This is required for the HLS/transcode path on iOS: the
   *   player view is still occluded by the modal loading dialog at this point,
   *   and iOS never presents a frame for an off-screen video, so waiting for
   *   `requestVideoFrameCallback` would deadlock (player won't show until a
   *   frame is decoded; a frame won't present until the player is shown).
   *   The presented-frame wait is only needed for direct-playback probing,
   *   where it doubles as a codec-decodability check.
   * @returns {Promise<void>}
   */
  async #ensureVideoReady(options = {}) {
    const requireDecodedFrame = options?.requireDecodedFrame !== false;
    const videoElement = this.#videoElement;
    if (!(videoElement instanceof HTMLVideoElement)) {
      throw new Error(Loading.MESSAGES.playerNotReady);
    }
    if (videoElement.error) {
      throw new Error(Loading.MESSAGES.selectedFileUnsupported);
    }
    if (videoElement.readyState >= HTMLMediaElement.HAVE_METADATA) {
      // In lenient mode (transcode path) the stream is known-compatible. Skip the
      // dimensions/decoded-frame checks: iOS does not populate videoWidth/Height
      // nor present frames while the <video> is still occluded by the modal
      // loading dialog, so those checks would spuriously report "unsupported".
      if (requireDecodedFrame) {
        if (videoElement.videoWidth <= 0 || videoElement.videoHeight <= 0) {
          throw new Error(Loading.MESSAGES.selectedFileUnsupported);
        }
        await this.#waitForDecodedVideoFrame(videoElement);
      }
      return;
    }
    await new Promise((resolve, reject) => {
      const timeoutId = window.setTimeout(() => {
        cleanup();
        if (videoElement.error) {
          reject(new Error(Loading.MESSAGES.selectedFileUnsupported));
          return;
        }
        resolve(undefined);
      }, 1500);

      const onLoadedMetadata = () => {
        cleanup();
        resolve(undefined);
      };
      const onError = () => {
        cleanup();
        reject(new Error(Loading.MESSAGES.selectedFileUnsupported));
      };
      const cleanup = () => {
        window.clearTimeout(timeoutId);
        videoElement.removeEventListener("loadedmetadata", onLoadedMetadata);
        videoElement.removeEventListener("error", onError);
      };

      videoElement.addEventListener("loadedmetadata", onLoadedMetadata, { once: true });
      videoElement.addEventListener("error", onError, { once: true });
    });
    if (requireDecodedFrame) {
      if (videoElement.videoWidth <= 0 || videoElement.videoHeight <= 0) {
        throw new Error(Loading.MESSAGES.selectedFileUnsupported);
      }
      await this.#waitForDecodedVideoFrame(videoElement);
    }
  }

  /**
   * @param {HTMLVideoElement} videoElement
   * @returns {Promise<void>}
   */
  async #waitForDecodedVideoFrame(videoElement) {
    if (typeof videoElement.requestVideoFrameCallback === "function") {
      await new Promise((resolve, reject) => {
        const timeoutId = window.setTimeout(() => {
          reject(new Error(Loading.MESSAGES.selectedFileUnsupported));
        }, 4000);
        videoElement.requestVideoFrameCallback(() => {
          window.clearTimeout(timeoutId);
          resolve(undefined);
        });
      });
      return;
    }

    if (typeof videoElement.webkitDecodedFrameCount === "number") {
      const initialCount = videoElement.webkitDecodedFrameCount;
      const startedAt = Date.now();
      while (Date.now() - startedAt < 4000) {
        if (videoElement.webkitDecodedFrameCount > initialCount) {
          return;
        }
        await new Promise((resolve) => {
          window.setTimeout(resolve, 100);
        });
      }
      throw new Error(Loading.MESSAGES.selectedFileUnsupported);
    }
  }

  /**
   * @param {unknown} error
   * @returns {boolean}
   */
  #isUnsupportedError(error) {
    return error instanceof Error && error.message === Loading.MESSAGES.selectedFileUnsupported;
  }

  /**
   * @param {unknown} error
   * @returns {boolean}
   */
  #isAbortError(error) {
    if (error instanceof DOMException) {
      return error.name === "AbortError";
    }
    return error instanceof Error && error.name === "AbortError";
  }

  /**
   * Emit a debug line to the browser console.  All playback decisions,
   * fallbacks and failures are mirrored here (in addition to the on-screen
   * status) so issues can be diagnosed from the console.
   *
   * @param {string} message
   * @param {unknown} [data]
   * @returns {void}
   */
  #debug(message, data) {
    if (data === undefined) {
      console.debug(`[torrent-tv] ${message}`);
      return;
    }
    console.debug(`[torrent-tv] ${message}`, data);
  }

  /**
   * @param {{ audioCodec?: string, videoCodec?: string }} codecs
   * @returns {Promise<{ audioSupported: boolean, videoSupported: boolean }>}
   */
  async #predictCodecSupport(codecs) {
    const [audioSupported, videoSupported] = await Promise.all([
      this.#isAudioCodecLikelySupported(codecs.audioCodec),
      this.#isVideoCodecLikelySupported(codecs.videoCodec)
    ]);
    return { audioSupported, videoSupported };
  }

  /**
   * @param {string | undefined} codec
   * @returns {Promise<boolean>}
   */
  async #isAudioCodecLikelySupported(codec) {
    const normalized = typeof codec === "string" ? codec.trim().toLowerCase() : "";
    if (!normalized) {
      return true;
    }
    const mediaCapabilities = await this.#checkMediaCapabilitiesAudioSupport(normalized);
    if (mediaCapabilities != null) {
      return mediaCapabilities;
    }
    const audio = document.createElement("audio");
    const mimeCandidates = AUDIO_CODEC_MIME_CANDIDATES[normalized] ?? [];
    if (mimeCandidates.length === 0) {
      return false;
    }
    for (const mime of mimeCandidates) {
      const support = audio.canPlayType(mime);
      if (support === "probably" || support === "maybe") {
        return true;
      }
    }
    return false;
  }

  /**
   * @param {string | undefined} codec
   * @returns {Promise<boolean>}
   */
  async #isVideoCodecLikelySupported(codec) {
    const normalized = typeof codec === "string" ? codec.trim().toLowerCase() : "";
    if (!normalized) {
      // Unknown video codec: do NOT assume it is playable. Copying an
      // undecodable codec (e.g. xvid) yields a black screen, and the WebRTC
      // transport has no direct-playback probe to fall back on. Treat unknown
      // as unsupported so the video track is transcoded to H.264.
      return false;
    }
    const mediaCapabilities = await this.#checkMediaCapabilitiesVideoSupport(normalized);
    if (mediaCapabilities != null) {
      return mediaCapabilities;
    }
    const video = document.createElement("video");
    const mimeCandidates = VIDEO_CODEC_MIME_CANDIDATES[normalized] ?? [];
    if (mimeCandidates.length === 0) {
      return false;
    }
    for (const mime of mimeCandidates) {
      const support = video.canPlayType(mime);
      if (support === "probably" || support === "maybe") {
        return true;
      }
    }
    return false;
  }

  /**
   * Start polling `/api/sources/:sourceKey/stats` every 2 s and update the
   * loading status with peer count, speed, and file download progress.
   *
   * Returns a stop function — call it when the metadata wait is over.
   *
   * @param {import("../../domain/proxy-transport.js").ProxyTransport} transport
   * @param {string} sourceKey
   * @param {number} fileIndex
   * @returns {() => void} Stop polling.
   */
  #startTorrentStatsPoll(transport, sourceKey, fileIndex) {
    let stopped = false;

    const poll = async () => {
      while (!stopped) {
        try {
          const resp = await transport.fetch(
            `/api/sources/${encodeURIComponent(sourceKey)}/stats?fileIndex=${fileIndex}`,
            { cache: "no-store" }
          );
          if (!stopped && resp.ok) {
            const stats = await resp.json();
            if (!stopped) {
              this.#updateMetadataStatus(stats);
            }
          }
        } catch (_error) {
          // Ignore transient errors — proxy may not be ready yet.
        }
        if (!stopped) {
          await new Promise((resolve) => setTimeout(resolve, 2_000));
        }
      }
    };

    void poll();
    return () => {
      stopped = true;
    };
  }

  /**
   * Render the "Fetching file metadata" status line with live torrent stats.
   *
   * Opening a torrent and resuming after a seek are the same wait for the
   * viewer, so they are described by the SAME line, built by the SAME code
   * ({@link #formatBufferingText}) — same metrics, same single end-to-end
   * "time until playback" figure. Previously this screen computed its own
   * narrower "time to next phase", which answered a different question and
   * could disagree with what the seek overlay showed for the same session.
   *
   * The whole-file line stays: during the initial fetch the file is genuinely
   * being downloaded from zero, and its size/progress is real, relevant
   * context that has no equivalent mid-playback.
   *
   * @param {{
   *   numPeers?: number, downloadSpeed?: number,
   *   fileProgress?: number, fileDownloaded?: number, fileLength?: number,
   *   headerBytes?: number, headerDownloadedBytes?: number
   * }} stats
   */
  #updateMetadataStatus(stats) {
    const _fileProgress = typeof stats?.fileProgress === "number" ? stats.fileProgress : null;
    const _fileDownloaded = typeof stats?.fileDownloaded === "number" ? stats.fileDownloaded : null;
    const _fileLength = typeof stats?.fileLength === "number" ? stats.fileLength : null;
    const headerBytes = typeof stats?.headerBytes === "number" ? stats.headerBytes : null;
    const headerDownloadedBytes =
      typeof stats?.headerDownloadedBytes === "number" ? stats.headerDownloadedBytes : null;

    // Until the codec probe can run, "what still has to arrive" is the file
    // header — so it plays the role the resume window plays mid-playback, and
    // feeds the shared formatter through the same fields.
    const statsForShared = {
      ...stats,
      resumeNeededBytes: headerBytes,
      resumeDownloadedBytes: headerDownloadedBytes
    };
    // Retained so the later transcode/pre-buffer screens can keep showing the
    // supply stage instead of dropping it the moment a session appears.
    this.#lastDownloadStats = statsForShared;
    // The step is a NAME. Peers, rate and what is left are measurements and
    // they reach the overlay on their own; composing them into the step here is
    // what put the word "undefined" on screen when this call stopped returning
    // text.

    if (headerBytes !== null && headerBytes > 0 && headerDownloadedBytes !== null) {
      // The bar still advances on header progress; the text does not show this
      // percent — the header is a handful of whole pieces, so it jumps
      // 0 → 50 → 100 and reads as broken.
      this.#setPhaseProgress(0, Math.max(0, Math.min(100, (headerDownloadedBytes / headerBytes) * 100)));
    }

    // How much of the WHOLE file has been downloaded is not a thing anyone is
    // waiting for: the file is read as a stream, and playback starts on a
    // cushion of seconds, not on a percentage of gigabytes. Shown beside the
    // real figures it invited exactly the wrong question — "why is it still
    // downloading if it is already transcoding" — about a number that was never
    // going to reach 100 before the picture started.

    this.setStatus(Loading.MESSAGES.fetchingMetadata);
  }



  /**
   * @param {{
   *  audioCodec: string,
   *  videoCodec: string,
   *  audioSupported: boolean,
   *  videoSupported: boolean,
   *  plannerMode: string,
   *  shouldTranscodeAudio: boolean,
   *  shouldTranscodeVideo: boolean
   * }} details
   * @returns {string}
   */
  #buildTranscodeReason(details) {
    const reasons = [];
    if (details.shouldTranscodeVideo) {
      reasons.push(
        `video codec ${this.#formatCodecName(details.videoCodec)} is not supported by this browser`
      );
    }
    if (details.shouldTranscodeAudio) {
      if (details.plannerMode === "hls") {
        reasons.push(
          `proxy planner requires HLS for audio codec ${this.#formatCodecName(details.audioCodec)}`
        );
      } else if (!details.audioSupported) {
        reasons.push(
          `audio codec ${this.#formatCodecName(details.audioCodec)} is not supported by this browser`
        );
      } else {
        reasons.push("audio transcode was requested by playback planner");
      }
    }
    if (reasons.length === 0) {
      return "Reason: transcode path selected by compatibility checks.";
    }
    return `Reason: ${reasons.join("; ")}.`;
  }

  /**
   * @param {string | undefined} codec
   * @returns {string}
   */
  #formatCodecName(codec) {
    const value = typeof codec === "string" ? codec.trim() : "";
    return value.length > 0 ? value : "unknown";
  }

  /**
   * Build the transcode target resolution sent to the proxy.
   *
   * Orientation-independent by design: the target is sized from the viewport's
   * LONG and SHORT edges (not the current width/height, and not the
   * `<video>` bounding box, which shrinks in portrait because a landscape clip
   * is letterboxed there). So the target is identical in portrait and
   * landscape and always provisions for the landscape (larger) case. Rotating
   * the device mid-playback therefore never needs more pixels and never forces
   * a transcode restart; in portrait the player just downscales the extra
   * pixels. The proxy caps this box to the source size (never upscales), and
   * the realtime budget scales DOWN from this ceiling — orientation itself
   * never changes the encode resolution.
   *
   * @param {boolean} shouldTranscodeVideo
   * @returns {{ targetWidth?: number, targetHeight?: number }}
   */
  #buildVideoTargetConfig(shouldTranscodeVideo) {
    if (!shouldTranscodeVideo || !(this.#videoElement instanceof HTMLVideoElement)) {
      return {};
    }
    const viewportWidth = Number.isFinite(window.innerWidth) && window.innerWidth > 0 ? window.innerWidth : 0;
    const viewportHeight = Number.isFinite(window.innerHeight) && window.innerHeight > 0 ? window.innerHeight : 0;
    const longEdge = Math.max(viewportWidth, viewportHeight);
    const shortEdge = Math.min(viewportWidth, viewportHeight);
    if (longEdge <= 0 || shortEdge <= 0) {
      return {};
    }
    const dpr = Number.isFinite(window.devicePixelRatio) && window.devicePixelRatio > 0
      ? window.devicePixelRatio
      : 1;
    const scaleFactor = 0.95;
    const targetWidth = this.#toEvenDimension(Math.round(longEdge * dpr * scaleFactor));
    const targetHeight = this.#toEvenDimension(Math.round(shortEdge * dpr * scaleFactor));
    if (targetWidth <= 0 || targetHeight <= 0) {
      return {};
    }
    return { targetWidth, targetHeight };
  }

  /**
   * Build the transcode target for the request, honouring a manual quality
   * choice. On Auto (`#selectedQualityHeight === 0`) this is the
   * orientation-independent ceiling (realtime budget decides the rest on the
   * proxy). When the viewer forced a resolution, the target is exactly that
   * height at the source aspect ratio, flagged `manualQuality` so the proxy
   * encodes it as-is (capped to source) with the budget disabled.
   *
   * @param {boolean} shouldTranscodeVideo
   * @returns {{ targetWidth?: number, targetHeight?: number, manualQuality?: boolean }}
   */
  #buildQualityTargetConfig(shouldTranscodeVideo) {
    if (!shouldTranscodeVideo) {
      return {};
    }
    const forcedHeight = this.#selectedQualityHeight;
    if (
      Number.isInteger(forcedHeight) &&
      forcedHeight > 0 &&
      this.#sourceVideoWidth > 0 &&
      this.#sourceVideoHeight > 0
    ) {
      const height = Math.min(forcedHeight, this.#sourceVideoHeight);
      const width = this.#toEvenDimension((this.#sourceVideoWidth * height) / this.#sourceVideoHeight);
      const evenHeight = this.#toEvenDimension(height);
      if (width > 0 && evenHeight > 0) {
        return { targetWidth: width, targetHeight: evenHeight, manualQuality: true };
      }
    }
    return this.#buildVideoTargetConfig(shouldTranscodeVideo);
  }

  /**
   * Quality options for the player menu: Auto plus each standard resolution at
   * or below the source height. Shown for any proxy-served stream whose source
   * resolution is known (empty → menu hidden) — including a directly-played
   * codec, where picking a resolution forces a downscaling re-encode (Auto
   * keeps the copy). Only downscales are offered; the source is the ceiling.
   *
   * @returns {Array<{ height: number, label: string }>}
   */
  /**
   * Take the height the proxy is producing from a progress report, and refresh
   * the menu when it has changed under automatic quality.
   *
   * Only then: a forced resolution does not move, and rebuilding the menu on
   * every poll would replace its items about once a second for no reason.
   *
   * @param {{ currentHeight?: number } | null} progress
   * @returns {void}
   */
  /**
   * Take the host's own timings from a progress report.
   *
   * They also arrive on the playback plan, but that is read once per file — so
   * on a proxy that had just restarted, when neither figure existed yet, the
   * browser kept the nulls for the whole session and every later seek estimated
   * the wait with one term of four. This response is polled about every 1.5 s.
   *
   * @param {{ expectedSessionCreateMs?: number, expectedFirstSegmentMs?: number } | null} progress
   * @returns {void}
   */
  #noteHostTimings(progress) {
    const create = Number(progress?.expectedSessionCreateMs);
    if (Number.isFinite(create) && create > 0) {
      this.#expectedSessionCreateSeconds = create / 1000;
    }
    const first = Number(progress?.expectedFirstSegmentMs);
    if (Number.isFinite(first) && first > 0) {
      this.#expectedFirstSegmentSeconds = first / 1000;
    }
  }

  /**
   * The player finished switching variant: the rung named here is the one on
   * screen, which is not the one that was asked for until the first fragment of
   * the new variant has been appended.
   *
   * @param {number} height
   * @returns {void}
   */
  #onHlsLevelSwitched(height) {
    if (height > 0) {
      this.#logEvt(`quality: now playing ${height}p`);
    }
    this.#publishQualityOptions();
  }

  #noteEffectiveQuality(progress) {
    const height = Number(progress?.currentHeight);
    const effective = Number.isFinite(height) && height > 0 ? Math.round(height) : 0;
    if (effective === this.#autoEffectiveHeight) {
      return;
    }
    this.#autoEffectiveHeight = effective;
    if (this.#selectedQualityHeight !== 0) {
      return;
    }
    this.#logEvt(`automatic quality is now ${effective > 0 ? `${effective}p` : "the source's own height"}`);
    this.#publishQualityOptions();
  }

  /**
   * Put the quality menu on screen, saying which rung is playing.
   *
   * One place, because the answer comes from two sources now — the player's own
   * variants where the stream has them, the source's height where it does not —
   * and three moments publish it.
   *
   * @returns {void}
   */
  #publishQualityOptions() {
    const levels = this.#hlsPlayer.levels();
    const activeLevel = levels.find((level) => level.index === this.#hlsPlayer.currentLevel());
    document.dispatchEvent(
      new CustomEvent(PLAYER_EVENTS.SET_QUALITY_OPTIONS, {
        detail: {
          options: this.#buildQualityOptions(),
          // With variants the menu says what is PLAYING, which is the player's
          // to answer: a pick takes effect a fragment later, and until then the
          // old rung is still on screen.
          activeHeight: activeLevel ? activeLevel.height : this.#selectedQualityHeight
        }
      })
    );
  }

  #buildQualityOptions() {
    // The variants the player itself reports, when the proxy published a master
    // playlist for this stream. Built from what the player has, not from a list
    // assembled separately, so the menu cannot offer a rung that is not there.
    const named = this.#hlsPlayer.levels()
      .filter((level) => level.height > 0)
      .sort((left, right) => right.height - left.height);
    // More than one rung, and each of them says what it is. A variant whose
    // height the player could not read is one the menu cannot name, and a menu
    // of one unnamed entry is worse than the list below it.
    if (named.length > 1) {
      return named.map((level) => ({
        height: level.height,
        label: level.height === this.#sourceVideoHeight
          ? `${level.height}p (source)`
          : `${level.height}p`
      }));
    }
    if (!(this.#sourceVideoHeight > 0)) {
      return [];
    }
    // Automatic says what it currently IS. The proxy steps the resolution down
    // when the host cannot encode in realtime or the viewer's link cannot carry
    // the stream, and the menu read only "Auto" — so the viewer could see the
    // picture soften and find no answer anywhere to what they were watching.
    const options = [{
      height: 0,
      label: this.#autoEffectiveHeight > 0 ? `Auto (${this.#autoEffectiveHeight}p)` : "Auto"
    }];
    const ladder = [2160, 1440, 1080, 720, 540, 480, 360, 240];
    // The source height itself as the top forced rung (labelled), then standard
    // rungs strictly below it. Never offer above the source (no upscaling).
    options.push({ height: this.#sourceVideoHeight, label: `${this.#sourceVideoHeight}p (source)` });
    for (const height of ladder) {
      if (height < this.#sourceVideoHeight) {
        options.push({ height, label: `${height}p` });
      }
    }
    return options;
  }

  /**
   * @param {number} value
   * @returns {number}
   */
  #toEvenDimension(value) {
    if (!Number.isFinite(value)) {
      return 0;
    }
    const safe = Math.max(2, Math.floor(value));
    return safe % 2 === 0 ? safe : safe - 1;
  }

  /**
   * @param {string} codec
   * @returns {boolean}
   */
  #canCopyAudioCodecForHls(codec) {
    if (!HLS_AUDIO_COPY_COMPATIBLE_CODECS.has(codec)) {
      return false;
    }
    // Being a codec HLS can carry is not enough — it also has to survive the
    // trip into MediaSource, and that depends on the container. MP3 is the case
    // that matters: it cannot be copied into fMP4 at all, but hls.js can carry
    // it in MPEG-TS, so #requiredSegmentFormat asks the proxy for that
    // container instead of giving up on the copy.
    return canAppendCopiedAudio(codec, "fmp4") || canAppendCopiedAudio(codec, "mpegts");
  }

  /**
   * The container this browser needs for the tracks it wants copied, or `""`
   * when it has no preference and the proxy's own setting should stand.
   *
   * fMP4 is the better default and stays it: MediaSource takes Opus, FLAC, AV1
   * and VP9 inside MP4 but has no place for them in MPEG-TS, and an fMP4
   * segment reaches the decoder without hls.js having to rebuild it. The one
   * thing MPEG-TS carries that fMP4 cannot is MP3 — measured in Chromium,
   * `audio/mp4; codecs="mp4a.69"` is refused while `audio/mpeg` is accepted,
   * and hls.js falls back to exactly that buffer when it demuxes MPEG-TS. A
   * copied MP3 track in fMP4 therefore loads forever without ever playing.
   *
   * @param {{ audioCodec?: string, transcodeAudio: boolean }} plan
   * @returns {string}
   */
  #requiredSegmentFormat({ audioCodec, transcodeAudio }) {
    if (transcodeAudio) {
      // The audio is being re-encoded to AAC, which both containers carry.
      return "";
    }
    const codec = typeof audioCodec === "string" ? audioCodec.trim().toLowerCase() : "";
    if (!codec || canAppendCopiedAudio(codec, "fmp4")) {
      return "";
    }
    return canAppendCopiedAudio(codec, "mpegts") ? "mpegts" : "";
  }

  /**
   * @param {string} codec
   * @returns {Promise<boolean | null>}
   */
  async #checkMediaCapabilitiesAudioSupport(codec) {
    if (
      typeof navigator !== "object" ||
      !navigator ||
      typeof navigator.mediaCapabilities !== "object" ||
      typeof navigator.mediaCapabilities.decodingInfo !== "function"
    ) {
      return null;
    }
    const mimeCandidates = AUDIO_CODEC_MIME_CANDIDATES[codec] ?? [];
    for (const contentType of mimeCandidates) {
      try {
        const result = await navigator.mediaCapabilities.decodingInfo({
          type: "file",
          audio: {
            contentType,
            channels: "2",
            bitrate: 160000,
            samplerate: 48000
          }
        });
        if (result && typeof result.supported === "boolean") {
          return result.supported;
        }
      } catch (_error) {
        // Ignore and fall back to canPlayType path.
      }
    }
    return null;
  }

  /**
   * @param {string} codec
   * @returns {Promise<boolean | null>}
   */
  async #checkMediaCapabilitiesVideoSupport(codec) {
    if (
      typeof navigator !== "object" ||
      !navigator ||
      typeof navigator.mediaCapabilities !== "object" ||
      typeof navigator.mediaCapabilities.decodingInfo !== "function"
    ) {
      return null;
    }
    const mimeCandidates = VIDEO_CODEC_MIME_CANDIDATES[codec] ?? [];
    for (const contentType of mimeCandidates) {
      try {
        const result = await navigator.mediaCapabilities.decodingInfo({
          type: "file",
          video: {
            contentType,
            width: 1920,
            height: 1080,
            bitrate: 5_000_000,
            framerate: 30
          }
        });
        if (result && typeof result.supported === "boolean") {
          return result.supported;
        }
      } catch (_error) {
        // Ignore and fall back to canPlayType path.
      }
    }
    return null;
  }
}

const AUDIO_CODEC_MIME_CANDIDATES = {
  aac: ['audio/mp4; codecs="mp4a.40.2"'],
  mp3: ['audio/mpeg; codecs="mp3"', 'audio/mpeg'],
  opus: ['audio/webm; codecs="opus"', 'audio/ogg; codecs="opus"'],
  vorbis: ['audio/webm; codecs="vorbis"', 'audio/ogg; codecs="vorbis"'],
  flac: ['audio/flac', 'audio/mp4; codecs="flac"'],
  ac3: ['audio/mp4; codecs="ac-3"'],
  eac3: ['audio/mp4; codecs="ec-3"']
};

const VIDEO_CODEC_MIME_CANDIDATES = {
  h264: ['video/mp4; codecs="avc1.42E01E"'],
  hevc: ['video/mp4; codecs="hvc1.1.6.L93.B0"', 'video/mp4; codecs="hev1.1.6.L93.B0"'],
  av1: ['video/mp4; codecs="av01.0.08M.08"', 'video/webm; codecs="av01.0.08M.08"'],
  vp9: ['video/webm; codecs="vp9"', 'video/mp4; codecs="vp09.00.10.08"'],
  vp8: ['video/webm; codecs="vp8"']
  // mpeg4 (MPEG-4 Part 2: xvid/divx) and mpeg2video are intentionally omitted:
  // mainstream browsers cannot decode them, so an empty candidate list makes
  // #isVideoCodecLikelySupported return false → the video track is transcoded
  // to H.264 instead of being copied (which would play as a black screen).
};

const HLS_AUDIO_COPY_COMPATIBLE_CODECS = new Set(["aac", "mp3", "ac3", "eac3"]);

/**
 * The MediaSource type a copied audio track ends up as, per container.
 *
 * hls.js appends everything through MediaSource, so this — not `canPlayType` —
 * is the question that decides whether a copy plays. Measured in Chromium:
 * `canPlayType('audio/mp4; codecs="mp4a.69"')` answers "probably" for a type
 * `MediaSource.isTypeSupported` refuses.
 *
 * With fMP4 the proxy's segment reaches the decoder untouched, so the codec has
 * to be one MediaSource accepts inside MP4. With MPEG-TS hls.js demuxes and
 * rebuilds the stream itself, which changes the answer in exactly one place:
 * for MP3 it gives up on MP4 and appends to a plain `audio/mpeg` buffer
 * (verified in our own `vendor/hls.min.js`).
 */
const COPIED_AUDIO_MSE_TYPES = {
  fmp4: {
    aac: 'audio/mp4; codecs="mp4a.40.2"',
    mp3: 'audio/mp4; codecs="mp4a.69"',
    ac3: 'audio/mp4; codecs="ac-3"',
    eac3: 'audio/mp4; codecs="ec-3"'
  },
  mpegts: {
    aac: 'audio/mp4; codecs="mp4a.40.2"',
    mp3: "audio/mpeg",
    // hls.js remuxes these into MP4 too, so the container buys nothing.
    ac3: 'audio/mp4; codecs="ac-3"',
    eac3: 'audio/mp4; codecs="ec-3"'
  }
};

/**
 * Whether a copied audio track can be appended when the proxy produces
 * `container`.
 *
 * @param {string} codec - Lower-case codec name from the playback plan.
 * @param {"fmp4" | "mpegts"} container
 * @returns {boolean}
 */
function canAppendCopiedAudio(codec, container) {
  const mime = COPIED_AUDIO_MSE_TYPES[container]?.[codec];
  if (!mime) {
    return false;
  }
  if (typeof MediaSource !== "function" || typeof MediaSource.isTypeSupported !== "function") {
    // No MediaSource to ask (iOS native HLS plays the playlist itself, and it
    // handles every codec HLS defines). Do not block the copy.
    return true;
  }
  const supported = MediaSource.isTypeSupported(mime);
  // Both sides of the answer, because this decision is why a track is copied
  // rather than re-encoded, and a wrong "yes" here is indistinguishable at
  // playback from a file that is simply arriving too slowly — the two need very
  // different fixes and the log could not tell them apart.
  console.debug(`[evt] codec-support audio ${codec}/${container} asked "${mime}" -> ${supported}`);
  return supported;
}
// Pre-buffer cushion accumulated before the player is revealed, so a transient
// dip right after start does not immediately stall. Kept under the proxy's
// look-ahead window (~32 s). The timeout starts playback anyway if a slow
// encoder cannot fill the cushion in time.
// Pre-buffer cushion. The target is adaptive (see #waitForPrebuffer): smaller
// when production has comfortable margin over realtime, larger when it barely
// keeps up. PREBUFFER_TARGET_SECONDS is the fallback before the fill rate is
// measurable. PREBUFFER_MAX_SECONDS must stay under hls.js maxBufferLength (30)
// and the proxy look-ahead window (~32 s), or buffering ahead triggers a
// seek-restart.
// A scrub emits `seeking` on every pointer move; only where it settles counts.
// Long enough to collapse a drag into one report, short enough that the encoder
// starts on the real target promptly.
const SEEK_REPORT_DEBOUNCE_MS = 300;
const _PREBUFFER_TARGET_SECONDS = 15;
// ffmpeg's `speed` is a CUMULATIVE average over the whole run, so the first
// samples after a (re)start are dominated by process start-up and input open —
// not by encoding. Field-observed on a seek-restart: `0.00757x` a second in,
// settling to `1.4x` shortly after. Feeding that first sample into an ETA gave
// "32m 56s to playback" for a 15 s cushion (14.958 / 0.00757), and printing it
// verbatim gave "0.00757x realtime". Ignore the multiplier — for both the ETA
// and the display — until the run has actually produced this many seconds of
// content, by which point the cumulative average is meaningful.
// Trailing window over which the buffer's fill rate is averaged. Media lands in
// whole segments (~4 s each, in bursts), so a rate taken between two adjacent
// polls alternates between a spike and zero; the window smooths that into the
// sustained rate the ETA needs. The minimum span stops a rate being reported
// from a window too short to have seen a segment arrive at all.
const BUFFER_FILL_WINDOW_MS = 12_000;
const BUFFER_FILL_MIN_SPAN_MS = 3_000;
const _PREBUFFER_MIN_SECONDS = 6;
// What the player needs before it resumes ITSELF after a seek. Nothing of ours
// gates that moment — hls.js and iOS native both start as soon as the new
// position is covered, measured 2026-08-05 at 0.5 s buffered. Kept a little
// above what was measured so the figure does not reach zero before the picture
// moves, but nowhere near the first-open cushion: counting a seek toward 15 s
// described a moment that never came, and the number still read 4.9 s when
// playback had already resumed.
const _RESUME_TARGET_SECONDS = 2;
// How often the playback position may be written to the address bar, so a
// bookmark taken at any moment is at most this far behind the picture.
// `timeupdate` fires about four times a second, which is far too often to
// touch history; one second is sixty writes per thirty seconds, against the
// hundred at which Safari — the strictest, and the same engine on iOS — starts
// refusing. These writes REPLACE, so however long the film, the history does
// not grow by a single entry.
const URL_POSITION_INTERVAL_MS = 1_000;
// How fast the pipeline is assumed to fill the buffer before it has shown a
// rate of its own. Measured around 10x realtime on the two sessions of
// 2026-08-05; a fifth of that is used, so the estimate errs long rather than
// promising a speed nothing has yet demonstrated.
// How many recent playback starts are kept to learn how much buffer this
// player needs before it moves.
const PLAYBACK_START_SAMPLES = 5;
// The proxy's nominal segment length. Used only as the floor for "how much
// media is enough": no player starts on less than one segment, so this is a
// property of the playlist we serve, not a value chosen to make an estimate
// come out right.
const _PREBUFFER_MAX_SECONDS = 25;
const _PREBUFFER_BASE_SECONDS = 12;
// Start early when the fill rate has sustained a healthy surplus over the FULL
// buffer-fill window (BUFFER_FILL_WINDOW_MS above — not merely the shorter
// span that makes the rate trustworthy at all). The full-window requirement
// is the anti-burst protection from the 0.8.45 start-stutter fix: segments
// land in bursts every ~4-11 s on a slow/warming encoder, so a short window
// reads a single burst as "3x realtime" and releases with a tiny cushion that
// then drains. Below this fill rate the deeper adaptive target is kept (thin
// Allow a full cushion to build on a genuinely slow start before falling back.
const PREBUFFER_TIMEOUT_MS = 45_000;
// If, after the timeout, less than this is buffered, treat the stream as never
// started (dead transport) and fail rather than reveal an unplayable player.
const PREBUFFER_MIN_START_SECONDS = 0.5;
const DIRECT_PLAYBACK_HINTS_STORAGE_KEY = "torrent-tv-direct-playback-hints-v1";
const DIRECT_PLAYBACK_HINTS_MAX_ENTRIES = 400;
const DIRECT_PLAYBACK_HINT_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function bootstrapLoading() {
  new Loading();
}

if (document.readyState !== "loading") {
  bootstrapLoading();
} else {
  document.addEventListener("DOMContentLoaded", bootstrapLoading, { once: true });
}
