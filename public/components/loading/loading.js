import { createHlsPlayer } from "../../domain/hls-player.js";
import { getDebugState } from "../../shared/debug-state.js";
import { TorrentSession } from "../../domain/torrent-session.js";
import { ProxySelector } from "../proxy-selector/proxy-selector.js";
import { ProxyTransport } from "../../domain/proxy-transport.js";
import { createWebRtcHlsLoader } from "../../domain/webrtc-hls-loader.js";
import { APP_EVENTS, ERROR_EVENTS, LOADING_EVENTS, PLAYER_EVENTS } from "../../shared/events.js";
import { classifyMediaFiles, normalizeRemoteFileList } from "../../domain/torrent-parser.js";

/** Embedded-subtitle extraction reads the file to the last cue — allow long. */
const EMBEDDED_SUBTITLE_TIMEOUT_MS = 10 * 60_000;

/** A cold magnet needs swarm metadata before the file list exists. */
const MAGNET_METADATA_TIMEOUT_MS = 180_000;

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
export class Loading {
  static SELECTOR = {
    cancelButton: "#loading__cancel",
    dialog: "#loading",
    fileName: "#loading__filename",
    status: "#loading__status",
    progress: "#loading__progress"
  };

  static MESSAGES = {
    missingDomNodes: "Loading component DOM nodes are missing.",
    readingTorrentFile: (fileName) => fileName,
    readingMetadata: "Reading torrent metadata...",
    selectingProxy: "Selecting best proxy by available load metrics...",
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
    connectionLost: "Connection to the proxy was lost.",
    reconnecting: "Reconnecting...",
    switchingAudio: "Switching audio track...",
    switchingQuality: "Switching quality...",
    prebufferStalled: "Could not start playback — no data arrived from the proxy. If it is on your network, allow local network access for this site and try again.",
    fetchingMagnetMetadata: "Fetching torrent metadata from the swarm...",
    magnetMetadataFailed:
      "Could not fetch metadata for this magnet link — no peers reachable. Try again later."
  };

  // How long to keep polling for the file header to download before giving up
  // (cold torrent / peers connecting). The proxy returns `pending` quickly each
  // poll, so this is a wall-clock budget, not a single blocking request.
  static PLAN_WAIT_MS = 180_000;

  #dialog;
  #fileName;
  #status;
  #progress;
  #cancelButton;
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
  /** @type {number} Source coded width/height from the proxy plan (0 = unknown / not proxy-served). */
  #sourceVideoWidth = 0;
  #sourceVideoHeight = 0;

  /** @param {CustomEvent} event */
  #onShow = (event) => {
    const payload = event instanceof CustomEvent ? event.detail : null;
    this.#logEvt(`view=loading shown cause=LOADING:SHOW`);
    this.visible = true;
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
      this.#failPlayback(epoch, { description: message });
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
          `bufferedAhead=${this.#bufferedAheadSeconds(videoElement).toFixed(1)}s`
      );
    };
    for (const name of ["seeking", "seeked", "waiting", "playing", "pause", "ended", "stalled", "error"]) {
      videoElement.addEventListener(name, () => log(name));
    }
    // Periodic bottleneck classification while playing. Distinguishes, from
    // client-visible symptoms, whether playback is limited by the client's own
    // decode (dropped frames while the buffer holds) or by something upstream
    // (buffer draining — proxy CPU / proxy download / delivery, split later by
    // the budget using the proxy's own speed/download signals). Logged as
    // [bottleneck]; the client logger forwards it to the server log for field
    // analysis.
    let prevAhead = this.#bufferedAheadSeconds(videoElement);
    let prevDropped = 0;
    let prevTotal = 0;
    window.setInterval(() => {
      if (videoElement.paused || videoElement.ended || videoElement.readyState < 2) {
        return;
      }
      const t = new Date().toISOString().slice(11, 23);
      const ahead = this.#bufferedAheadSeconds(videoElement);
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

  #onPlayerShow = () => {
    this.#logEvt(`view=loading hidden cause=PLAYER:SHOW`);
    this.visible = false;
  };

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
      this.#failPlayback(epoch, { description: message });
    });
  };

  /** @param {CustomEvent} event */
  #onProcessMagnet = (event) => {
    const magnetUri = event instanceof CustomEvent ? event.detail?.magnetUri : "";
    const epoch = this.#beginPlaybackAttempt();
    void this.#processMagnetPlayback(magnetUri).catch((error) => {
      if (this.#isAbortError(error)) {
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      console.error("[torrent-tv] magnet playback failed:", message, error);
      this.#failPlayback(epoch, { description: message });
    });
  };

  #onErrorShow = () => {
    this.#stopPlayback();
    this.visible = false;
  };

  #onPageHide = () => {
    this.#stopPlayback({ preferBeacon: true, reason: "pagehide" });
  };

  #onBeforeUnload = () => {
    this.#stopPlayback({ preferBeacon: true, reason: "beforeunload" });
  };

  #onAppReset = () => {
    this.#stopPlayback();
    this.visible = false;
    this.setProgress(0);
    this.setStatus("");
    this.setFileName("Waiting for a .torrent file...");
    this.#directPlaybackUnsupportedCache.clear();
    this.#activeFileIndex = -1;
    this.#resumeState = null;
  };

  #stopPlayback(options = {}) {
    this.#isProcessing = false;
    this.#session.clear({
      preferBeacon: options?.preferBeacon === true,
      reason: typeof options?.reason === "string" ? options.reason : ""
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
    this.#dialog = document.querySelector(Loading.SELECTOR.dialog);
    this.#fileName = document.querySelector(Loading.SELECTOR.fileName);
    this.#status = document.querySelector(Loading.SELECTOR.status);
    this.#progress = document.querySelector(Loading.SELECTOR.progress);
    this.#cancelButton = document.querySelector(Loading.SELECTOR.cancelButton);

    if (!this.#dialog || !this.#fileName || !this.#status || !this.#progress || !this.#cancelButton) {
      throw new Error(Loading.MESSAGES.missingDomNodes);
    }
    this.#dialog.inert = true;

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
    document.addEventListener(PLAYER_EVENTS.SHOW, this.#onPlayerShow);
    document.addEventListener(ERROR_EVENTS.SHOW, this.#onErrorShow);
    document.addEventListener(APP_EVENTS.RESET_TO_PICKER, this.#onAppReset);
    window.addEventListener("pagehide", this.#onPageHide);
    window.addEventListener("beforeunload", this.#onBeforeUnload);
    this.#cancelButton.addEventListener("click", this.#onCancelClick);
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

  /** @param {boolean} value */
  set visible(value) {
    if (value) {
      this.#dialog.inert = false;
      if (!this.#dialog.open) {
        this.#dialog.showModal();
      }
      return;
    }
    if (this.#dialog.open) {
      this.#dialog.close();
    }
    this.#dialog.inert = true;
  }

  /** @param {string} value */
  setFileName(value) {
    this.#fileName.textContent = value;
  }

  /** @param {string} value */
  setStatus(value) {
    this.#status.textContent = value;
  }

  /** @param {number} value */
  setProgress(value) {
    const safeValue = Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : 0;
    // Monotonic: the bar only moves forward, except an explicit reset to 0 (new
    // file / new playback). This keeps it stable across within-phase
    // fluctuations (header pieces, warmup→first-segment) and phase boundaries.
    const applied = safeValue === 0 ? 0 : Math.max(safeValue, this.#progress.value);
    this.#progress.value = applied;
    this.#logEvt(`progress bar=${applied.toFixed(1)}% req=${safeValue.toFixed(1)}%`);
  }

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

      this.visible = true;
      this.setFileName(Loading.MESSAGES.readingTorrentFile(file.name));
      this.setStatus(Loading.MESSAGES.startingTorrentProcessing);
      this.setProgress(0);
      this.setStatus(Loading.MESSAGES.readingMetadata);

      const videoCount = mediaFiles.video.length;
      if (videoCount <= 0) {
        throw new Error(Loading.MESSAGES.noVideoFile);
      }
      if (videoCount === 1) {
        const videoFileIndex = mediaFiles.video[0].index;
        await this.#playVideoFile(videoFileIndex);
        void this.#loadSubtitlesForVideo(videoFileIndex).catch((e) => {
          if (!this.#isAbortError(e)) {
            console.warn("[torrent-tv][subtitles] load failed:", e);
          }
        });
      } else {
        this.setStatus(Loading.MESSAGES.chooseVideoFile);
        this.setProgress(100);
        document.dispatchEvent(new CustomEvent(LOADING_EVENTS.PLAYBACK_READY));
        document.dispatchEvent(new CustomEvent(PLAYER_EVENTS.OPEN_PLAYLIST));
        return;
      }

      this.setProgress(100);
      document.dispatchEvent(new CustomEvent(LOADING_EVENTS.PLAYBACK_READY));
    } finally {
      this.#isProcessing = false;
    }
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
  async #processMagnetPlayback(magnetUri) {
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

      const videoCount = mediaFiles.video.length;
      if (videoCount <= 0) {
        throw new Error(Loading.MESSAGES.noVideoFile);
      }
      if (videoCount === 1) {
        const videoFileIndex = mediaFiles.video[0].index;
        await this.#playVideoFile(videoFileIndex);
        void this.#loadSubtitlesForVideo(videoFileIndex).catch((e) => {
          if (!this.#isAbortError(e)) {
            console.warn("[torrent-tv][subtitles] load failed:", e);
          }
        });
      } else {
        this.setStatus(Loading.MESSAGES.chooseVideoFile);
        this.setProgress(100);
        document.dispatchEvent(new CustomEvent(LOADING_EVENTS.PLAYBACK_READY));
        document.dispatchEvent(new CustomEvent(PLAYER_EVENTS.OPEN_PLAYLIST));
        return;
      }

      this.setProgress(100);
      document.dispatchEvent(new CustomEvent(LOADING_EVENTS.PLAYBACK_READY));
    } finally {
      this.#isProcessing = false;
    }
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
      document.dispatchEvent(new CustomEvent(LOADING_EVENTS.PLAYBACK_READY));
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
    const transport = await this.#acquireTransport();
    this.#throwIfCancelled();
    if (!transport) {
      throw new Error(Loading.MESSAGES.noProxyAndNoWebseed);
    }

    // Register the torrent source early so we can poll live stats while
    // the proxy pre-fetches file metadata (MOOV atom / EBML headers).
    // prepareProxyPlaybackPlan will reuse the cached sourceKey.
    this.setStatus(Loading.MESSAGES.fetchingMetadata);
    this.#setPhaseProgress(0, 20); // phase 0 floor; header download % (stats poll) drives the rest
    const earlySourceKey = await this.#session.registerSourceOnProxy(transport);
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
        prepared = await this.#session.prepareProxyPlaybackPlan(fileIndex, transport);
        if (!prepared.pending) {
          break;
        }
        if (Date.now() >= planDeadline) {
          throw new Error(Loading.MESSAGES.headerDownloadStalled);
        }
        await new Promise((resolve) => setTimeout(resolve, 2_000));
      }
    } finally {
      stopStatsPoll();
    }

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
      await this.#playWithProxyTranscode(fileIndex, {
        transport,
        sourceKey: prepared.sourceKey,
        transcodeVideo: shouldTranscodeVideo,
        transcodeAudio: shouldTranscodeAudio || !this.#canCopyAudioCodecForHls(prepared.audioCodec),
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
    await this.#playWithProxyTranscode(fileIndex, {
      transport,
      sourceKey: prepared.sourceKey,
      transcodeVideo: shouldTranscodeVideo,
      transcodeAudio: shouldTranscodeAudio || !this.#canCopyAudioCodecForHls(prepared.audioCodec)
    });
    this.#setActiveMediaFile(fileIndex);
  }

  /**
   * Return the current open transport, or connect a new proxy and create one.
   * Stores the result in `#proxy` / `#transport` for reuse within the same session.
   *
   * @returns {Promise<import("../../domain/proxy-transport.js").ProxyTransport>}
   */
  async #acquireTransport() {
    if (this.#transport && (!this.#proxy || this.#proxy.isOpen)) {
      return this.#transport;
    }
    // Close stale proxy if present.
    if (this.#proxy) {
      this.#proxy.close();
      this.#proxy = null;
      this.#transport = null;
    }
    const proxy = await this.#proxySelector.chooseBestProxy();
    // Surface a mid-playback loss of this connection (Retry flow). A close()
    // by #stopPlayback never fires this.
    proxy.onConnectionLost = () => this.#onTransportLost();
    this.#proxy = proxy;
    this.#transport = ProxyTransport.fromWebRtc(proxy);
    return this.#transport;
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
    // Feed the player's quality menu (Auto + forced resolutions <= source).
    document.dispatchEvent(
      new CustomEvent(PLAYER_EVENTS.SET_QUALITY_OPTIONS, {
        detail: { options: this.#buildQualityOptions(), activeHeight: this.#selectedQualityHeight }
      })
    );
  }

  /**
   * The viewer picked a quality: replay the active file at the chosen
   * resolution (0 = Auto / realtime budget), preserving the position. Forcing a
   * resolution re-opens the transcode session at a fixed size (budget off), so
   * the resolution stays constant for the session — no mid-stream change.
   *
   * @param {CustomEvent} event
   */
  #onSelectQuality = (event) => {
    const detail = event instanceof CustomEvent ? event.detail : null;
    const height = Number(detail?.height);
    if (!Number.isInteger(height) || height < 0) {
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
   * With a file playing, capture everything Retry needs BEFORE the error
   * flow clears the session, then surface a recoverable error. While a
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
    const position =
      this.#videoElement instanceof HTMLVideoElement && Number.isFinite(this.#videoElement.currentTime)
        ? this.#videoElement.currentTime
        : 0;
    this.#resumeState = {
      fileIndex: this.#activeFileIndex,
      positionSeconds: position,
      sessionCurrent: current
    };
    document.dispatchEvent(
      new CustomEvent(LOADING_EVENTS.PLAYBACK_FAILED, {
        detail: { description: Loading.MESSAGES.connectionLost, canRetry: true }
      })
    );
  }

  /**
   * Retry after a lost connection: restore the session snapshot, replay the
   * normal file-switch flow (the proxy is re-selected — possibly a different
   * pool node) and jump back to the captured position. The seek is handled
   * like a user seek by the server-side seek machinery.
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
    this.#cancelRequested = false;
    this.#session.current = resume.sessionCurrent;
    const epoch = this.#beginPlaybackAttempt();
    void this.#switchToVideoFile(resume.fileIndex)
      .then(() => {
        if (resume.positionSeconds > 1 && this.#videoElement instanceof HTMLVideoElement) {
          this.#videoElement.currentTime = resume.positionSeconds;
        }
      })
      .catch((error) => {
        if (this.#isAbortError(error)) {
          return;
        }
        const message = error instanceof Error ? error.message : String(error);
        console.error("[torrent-tv] retry failed:", message, error);
        this.#failPlayback(epoch, { description: message });
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

    // For WebRTC transport, HLS.js must route all requests through the data channel.
    const hlsLoader = !transport.isHttp && this.#proxy
      ? createWebRtcHlsLoader(this.#proxy)
      : undefined;

    await this.#session.streamFileToVideoWithAudioTranscode(fileIndex, this.#videoElement, {
      transport,
      sourceKey: typeof options.sourceKey === "string" ? options.sourceKey : "",
      transcodeVideo: options.transcodeVideo === true,
      transcodeAudio: options.transcodeAudio === true,
      audioTrackIndex: this.#selectedAudioTrackIndex,
      ...this.#buildQualityTargetConfig(options.transcodeVideo === true),
      playHls: (videoElement, manifestUrl, playOptions = {}) =>
        this.#hlsPlayer.play(videoElement, manifestUrl, {
          ...(hlsLoader ? { loader: hlsLoader } : {}),
          ...playOptions
        }),
      onTranscodeProgress: (progress) => this.#renderTranscodeProgress(progress)
    });
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
    await this.#waitForPrebuffer(this.#videoElement, PREBUFFER_TARGET_SECONDS, PREBUFFER_TIMEOUT_MS);
  }

  /**
   * Wait until enough video is buffered ahead before revealing the player.
   *
   * The cushion size is ADAPTIVE: it is derived from the measured fill rate
   * `R` (media-seconds buffered per wall-second — the video is paused here, so
   * this is the production+delivery rate). During playback the buffer drains at
   * 1×, so the margin is `R − 1`. A comfortable margin needs only a small
   * cushion (it refills quickly → start sooner); a margin near zero needs a
   * large one (any dip drains it). Capped at `PREBUFFER_MAX_SECONDS`, which must
   * stay under hls.js `maxBufferLength` and the proxy look-ahead window so we
   * never buffer far enough ahead to trigger a seek-restart.
   *
   * Falls back to `defaultTargetSeconds` until the rate is measurable, and to
   * an absolute `timeoutMs` so a slow encoder never blocks playback forever.
   *
   * @param {HTMLVideoElement} videoElement
   * @param {number} defaultTargetSeconds
   * @param {number} timeoutMs
   * @returns {Promise<void>}
   */
  async #waitForPrebuffer(videoElement, defaultTargetSeconds, timeoutMs) {
    if (!(videoElement instanceof HTMLVideoElement)) {
      return;
    }
    // The player is hidden during pre-buffer, so the video MUST stay paused.
    // If it plays here it drains the buffer, so `ahead` never reaches the
    // target — the loading screen sticks while audio is heard. The player
    // starts playback in #onShow when revealed.
    if (!videoElement.paused) {
      this.#logEvt("player.pause reason=prebuffer");
      videoElement.pause();
    }
    const startedAt = Date.now();
    /** @type {Array<{ t: number, ahead: number }>} Rolling window for fill-rate. */
    const samples = [];
    let loggedTarget = -1;
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
      const ahead = this.#bufferedAheadSeconds(videoElement);

      // Fill rate R over a short rolling window.
      samples.push({ t: now, ahead });
      while (samples.length > 1 && now - samples[0].t > PREBUFFER_RATE_WINDOW_MS) {
        samples.shift();
      }
      const wallSpan = (now - samples[0].t) / 1000;
      // Trust the rate only once it spans enough wall time to average across
      // segment-arrival bursts; before that, hold the default target.
      const fillRate =
        wallSpan >= PREBUFFER_RATE_MIN_SPAN_MS / 1000 ? (ahead - samples[0].ahead) / wallSpan : NaN;

      // Adaptive target from the margin over realtime (R − 1).
      let target = defaultTargetSeconds;
      if (Number.isFinite(fillRate)) {
        const margin = fillRate - 1;
        target = margin <= 0
          ? PREBUFFER_MAX_SECONDS
          : Math.min(PREBUFFER_MAX_SECONDS, Math.max(PREBUFFER_MIN_SECONDS, PREBUFFER_BASE_SECONDS / margin));
      }
      target = Math.min(target, PREBUFFER_MAX_SECONDS);

      if (ahead >= target) {
        this.#logEvt(
          `prebuffer ready ahead=${ahead.toFixed(1)}s target=${target.toFixed(1)}s ` +
            `fillRate=${Number.isFinite(fillRate) ? fillRate.toFixed(2) : "n/a"}`
        );
        return;
      }
      if (Math.round(target) !== loggedTarget) {
        loggedTarget = Math.round(target);
        this.#logEvt(
          `prebuffer target=${loggedTarget}s ahead=${ahead.toFixed(1)}s ` +
            `fillRate=${Number.isFinite(fillRate) ? fillRate.toFixed(2) : "n/a"}`
        );
      }
      const pct = Math.max(0, Math.min(100, (ahead / target) * 100));
      this.#setPhaseProgress(2, pct); // phase 2 (buffering) fills the final third
      this.setStatus(`Buffering... ${Math.round(ahead)} / ${Math.round(target)} s`);
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    // Timed out. If NOTHING buffered, the stream never started (dead transport /
    // segments never arriving — e.g. a WebRTC connection blocked by the Local
    // Network Access gate). Fail loudly instead of revealing a dead player:
    // proceeding would fire PLAYBACK_READY over an element that can never play.
    const finalAhead = this.#bufferedAheadSeconds(videoElement);
    this.#logEvt(`prebuffer timeout ahead=${finalAhead.toFixed(1)}s`);
    if (finalAhead < PREBUFFER_MIN_START_SECONDS) {
      throw new Error(Loading.MESSAGES.prebufferStalled);
    }
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
   * Seconds of contiguously buffered media ahead of the current playback
   * position.
   *
   * @param {HTMLVideoElement} videoElement
   * @returns {number}
   */
  #bufferedAheadSeconds(videoElement) {
    const buffered = videoElement.buffered;
    const currentTime = videoElement.currentTime;
    for (let index = 0; index < buffered.length; index += 1) {
      if (buffered.start(index) <= currentTime + 0.25 && currentTime < buffered.end(index)) {
        return buffered.end(index) - currentTime;
      }
    }
    return 0;
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
   * Render loading status oriented to the FIRST segment — the only thing the
   * player waits for before playback starts. Shows transcoder warmup while
   * ffmpeg spins up, then progress toward producing the first segment with a
   * dynamic ETA derived from the encode speed. Used both by the warmup polling
   * inside the transcode session and by #startTranscodeProgressPoll.
   *
   * @param {object | null} progress
   * @returns {void}
   */
  #renderTranscodeProgress(progress) {
    if (!progress || typeof progress !== "object") {
      return;
    }
    const segmentDurationSec =
      typeof progress.segmentDurationSec === "number" && progress.segmentDurationSec > 0
        ? progress.segmentDurationSec
        : NaN;
    const startPositionSeconds =
      typeof progress.startPositionSeconds === "number" ? progress.startPositionSeconds : 0;
    const processedSeconds =
      typeof progress.processedSeconds === "number" ? progress.processedSeconds : NaN;
    const warmupPercent =
      typeof progress.warmupPercent === "number" ? progress.warmupPercent : NaN;
    const warmupRemainingSeconds =
      typeof progress.warmupRemainingSeconds === "number" ? progress.warmupRemainingSeconds : NaN;
    const speedText =
      typeof progress.speed === "string" && progress.speed.trim().length > 0
        ? progress.speed.trim()
        : "";

    // First-segment progress: how much of the first segment ffmpeg has encoded.
    const segmentProcessed = Number.isFinite(processedSeconds)
      ? Math.max(0, processedSeconds - startPositionSeconds)
      : NaN;
    if (Number.isFinite(segmentDurationSec) && Number.isFinite(segmentProcessed) && segmentProcessed >= 0) {
      const pct = Math.max(0, Math.min(100, (segmentProcessed / segmentDurationSec) * 100));
      const speedMultiplier = this.#parseSpeedMultiplier(speedText);
      const remainSeconds = Math.max(0, segmentDurationSec - segmentProcessed);
      const etaSeconds = speedMultiplier > 0 ? remainSeconds / speedMultiplier : NaN;
      const etaText = Number.isFinite(etaSeconds) ? this.#formatDuration(etaSeconds) : "n/a";
      // Phase 1 (transcode first segment) fills its third by first-segment %.
      this.#setPhaseProgress(1, pct);
      this.setStatus(
        `Preparing first segment... ${Math.round(pct)}%\n` +
          `ETA (dynamic): ${etaText}` +
          (speedText ? `\nSpeed: ${speedText}` : "")
      );
      return;
    }

    // Warmup phase: ffmpeg is starting and has not produced segment data yet.
    if (Number.isFinite(warmupPercent)) {
      const etaText = Number.isFinite(warmupRemainingSeconds)
        ? this.#formatDuration(warmupRemainingSeconds)
        : "n/a";
      // Warmup is the lead-in of phase 1 → fills only the first ~20% of its band
      // so the first-segment progress (0–100%) that follows doesn't jump back.
      this.#setPhaseProgress(1, warmupPercent * 0.2);
      this.setStatus(`Starting transcoder... ${Math.round(warmupPercent)}%\nETA (dynamic): ${etaText}`);
    }
  }

  /**
   * Parse an ffmpeg speed string like "3.24x" into a numeric multiplier.
   *
   * @param {string} speed
   * @returns {number} The multiplier, or NaN when not parseable.
   */
  #parseSpeedMultiplier(speed) {
    if (typeof speed !== "string") {
      return NaN;
    }
    const match = speed.match(/([\d.]+)\s*x/i);
    return match ? Number(match[1]) : NaN;
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
   * @param {{ numPeers?: number, downloadSpeed?: number, fileProgress?: number, fileDownloaded?: number, fileLength?: number }} stats
   */
  #updateMetadataStatus(stats) {
    const peers = typeof stats?.numPeers === "number" ? stats.numPeers : 0;
    const downloadSpeed = typeof stats?.downloadSpeed === "number" ? stats.downloadSpeed : 0;
    const speed = this.#formatBytes(downloadSpeed);
    const fileProgress = typeof stats?.fileProgress === "number" ? stats.fileProgress : null;
    const fileDownloaded = typeof stats?.fileDownloaded === "number" ? stats.fileDownloaded : null;
    const fileLength = typeof stats?.fileLength === "number" ? stats.fileLength : null;
    const headerBytes = typeof stats?.headerBytes === "number" ? stats.headerBytes : null;
    const headerDownloadedBytes =
      typeof stats?.headerDownloadedBytes === "number" ? stats.headerDownloadedBytes : null;

    const peersLine = `Peers: ${peers}`;
    const speedLine = `Speed: ${speed}/s`;

    // Phase 1 → phase 2 (transcode): progress and ETA toward having the
    // header/index downloaded so the codec probe can run. Coarse (whole pieces).
    let phaseLine = "";
    if (headerBytes !== null && headerBytes > 0 && headerDownloadedBytes !== null) {
      const pct = Math.max(0, Math.min(100, (headerDownloadedBytes / headerBytes) * 100));
      const remaining = Math.max(0, headerBytes - headerDownloadedBytes);
      const etaText =
        downloadSpeed > 0 ? `~${this.#formatDuration(remaining / downloadSpeed)}` : "n/a";
      phaseLine = `\nTo next phase: ${Math.round(pct)}% • ETA ${etaText}`;
      this.#setPhaseProgress(0, pct); // phase 0 (download) fills its third by header %
    }

    let fileLine = "";
    if (fileProgress !== null && fileLength !== null && fileLength > 0) {
      const pct = (fileProgress * 100).toFixed(1);
      const downloaded = this.#formatBytes(fileDownloaded ?? 0);
      const total = this.#formatBytes(fileLength);
      fileLine = `\nFile: ${pct}% (${downloaded} / ${total})`;
    }

    this.setStatus(`${Loading.MESSAGES.fetchingMetadata}\n${peersLine} • ${speedLine}${phaseLine}${fileLine}`);
  }

  /**
   * Format a byte count as a human-readable string (e.g. "1.2 MB").
   *
   * @param {number} bytes
   * @returns {string}
   */
  #formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes < 0) {
      return "0 B";
    }
    if (bytes === 0) {
      return "0 B";
    }
    const units = ["B", "KB", "MB", "GB"];
    const index = Math.min(Math.floor(Math.log2(bytes) / 10), units.length - 1);
    const value = bytes / Math.pow(1024, index);
    return `${value.toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
  }

  /**
   * @param {number} seconds
   * @returns {string}
   */
  #formatDuration(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) {
      return "00:00";
    }
    const total = Math.floor(seconds);
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const rest = total % 60;
    if (hours > 0) {
      return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`;
    }
    return `${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`;
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
  #buildQualityOptions() {
    if (!(this.#sourceVideoHeight > 0)) {
      return [];
    }
    const options = [{ height: 0, label: "Auto" }];
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
    return HLS_AUDIO_COPY_COMPATIBLE_CODECS.has(codec);
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
const PREBUFFER_TARGET_SECONDS = 15;
const PREBUFFER_MIN_SECONDS = 6;
const PREBUFFER_MAX_SECONDS = 25;
const PREBUFFER_BASE_SECONDS = 12;
// Fill-rate must be averaged over a window long enough to span SEVERAL segment
// arrivals — segments land in bursts every ~4-11 s on a slow/warming encoder,
// so a short window reads a single burst as "3x realtime" and releases with a
// tiny cushion that then drains (the ~35 s start-stutter). Only trust the rate
// once it covers at least PREBUFFER_RATE_MIN_SPAN_MS of wall time, so it
// reflects sustained production, not a spike.
const PREBUFFER_RATE_WINDOW_MS = 10_000;
const PREBUFFER_RATE_MIN_SPAN_MS = 5_000;
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
