import { APP_EVENTS, PLAYER_EVENTS } from "../../shared/events.js";

/**
 * MediaSession integration.
 *
 * Bridges the OS-level media controls (lock screen, notification shade,
 * hardware/headset keys, Picture-in-Picture) to the app's event-driven model:
 * - metadata reflects the currently active video file;
 * - play / pause / seek act on the shared `<video>` element;
 * - previous / next track dispatch `PLAYER:SELECT_MEDIA_FILE` for the adjacent
 *   video file (mirroring the playlist), and are disabled at the list edges;
 * - stop dispatches `APP:RESET_TO_PICKER` (closing the player) — the action the
 *   native in-page controls cannot offer.
 *
 * No-op on browsers without the MediaSession API.
 */
export class MediaSessionBridge {
  static SEEK_OFFSET_SECONDS = 10;
  static APP_NAME = "Torrent TV";

  /** @type {HTMLVideoElement | null} */
  #video = null;
  /** @type {Array<{ index?: number, name?: string, relativePath?: string }>} */
  #videoFiles = [];
  #currentFileIndex = -1;

  constructor() {
    if (typeof navigator !== "object" || !("mediaSession" in navigator)) {
      return;
    }
    this.#setupEventHandlers();
    this.#registerStaticActionHandlers();
    // Ask the player to (re)announce its <video> element in case it was created
    // before this component subscribed to PLAYER:READY.
    document.dispatchEvent(new CustomEvent(PLAYER_EVENTS.REQUEST_READY));
  }

  #setupEventHandlers() {
    document.addEventListener(PLAYER_EVENTS.READY, this.#onPlayerReady);
    document.addEventListener(PLAYER_EVENTS.SET_MEDIA_FILES, this.#onSetMediaFiles);
    document.addEventListener(PLAYER_EVENTS.SET_ACTIVE_MEDIA_FILE, this.#onSetActiveMediaFile);
    document.addEventListener(APP_EVENTS.RESET_TO_PICKER, this.#onReset);
  }

  /** @param {Event} event */
  #onPlayerReady = (event) => {
    const videoElement = event instanceof CustomEvent ? event.detail?.videoElement : null;
    if (!(videoElement instanceof HTMLVideoElement) || videoElement === this.#video) {
      return;
    }
    this.#video = videoElement;
    this.#video.addEventListener("play", this.#syncPlaybackState);
    this.#video.addEventListener("pause", this.#syncPlaybackState);
    this.#video.addEventListener("durationchange", this.#syncPositionState);
    this.#video.addEventListener("timeupdate", this.#syncPositionState);
    this.#video.addEventListener("ratechange", this.#syncPositionState);
  };

  /** @param {Event} event */
  #onSetMediaFiles = (event) => {
    const detail = event instanceof CustomEvent ? event.detail : null;
    this.#videoFiles = Array.isArray(detail?.video) ? detail.video : [];
    this.#updateMetadata();
    this.#updateTrackHandlers();
  };

  /** @param {Event} event */
  #onSetActiveMediaFile = (event) => {
    const detail = event instanceof CustomEvent ? event.detail : null;
    const fileIndex = Number(detail?.fileIndex);
    this.#currentFileIndex = Number.isInteger(fileIndex) ? fileIndex : -1;
    this.#updateMetadata();
    this.#updateTrackHandlers();
  };

  #onReset = () => {
    this.#videoFiles = [];
    this.#currentFileIndex = -1;
    navigator.mediaSession.metadata = null;
    navigator.mediaSession.playbackState = "none";
    this.#updateTrackHandlers();
  };

  /**
   * Register the action handlers that do not depend on playlist position.
   * Track navigation handlers are (un)set dynamically in #updateTrackHandlers.
   */
  #registerStaticActionHandlers() {
    this.#setActionHandler("play", () => {
      void this.#video?.play().catch(() => undefined);
    });
    this.#setActionHandler("pause", () => {
      this.#video?.pause();
    });
    this.#setActionHandler("seekbackward", (details) => {
      this.#seekBy(-(details?.seekOffset || MediaSessionBridge.SEEK_OFFSET_SECONDS));
    });
    this.#setActionHandler("seekforward", (details) => {
      this.#seekBy(details?.seekOffset || MediaSessionBridge.SEEK_OFFSET_SECONDS);
    });
    this.#setActionHandler("seekto", (details) => {
      if (this.#video && typeof details?.seekTime === "number") {
        this.#video.currentTime = details.seekTime;
      }
    });
    this.#setActionHandler("stop", () => {
      document.dispatchEvent(new CustomEvent(APP_EVENTS.RESET_TO_PICKER));
    });
  }

  /**
   * @param {MediaSessionAction} action
   * @param {MediaSessionActionHandler | null} handler
   */
  #setActionHandler(action, handler) {
    try {
      navigator.mediaSession.setActionHandler(action, handler);
    } catch {
      // Action unsupported by this browser — ignore.
    }
  }

  /** @param {number} deltaSeconds */
  #seekBy(deltaSeconds) {
    if (!this.#video || !Number.isFinite(this.#video.duration)) {
      return;
    }
    const target = this.#video.currentTime + deltaSeconds;
    this.#video.currentTime = Math.max(0, Math.min(this.#video.duration, target));
  }

  #updateTrackHandlers() {
    const position = this.#currentListPosition();
    const hasPrevious = position > 0;
    const hasNext = position >= 0 && position < this.#videoFiles.length - 1;
    this.#setActionHandler("previoustrack", hasPrevious ? () => this.#selectByOffset(-1) : null);
    this.#setActionHandler("nexttrack", hasNext ? () => this.#selectByOffset(1) : null);
  }

  /** @param {number} offset */
  #selectByOffset(offset) {
    const position = this.#currentListPosition();
    if (position < 0) {
      return;
    }
    const target = this.#videoFiles[position + offset];
    const fileIndex = Number(target?.index);
    if (!Number.isInteger(fileIndex)) {
      return;
    }
    document.dispatchEvent(
      new CustomEvent(PLAYER_EVENTS.SELECT_MEDIA_FILE, { detail: { fileIndex } })
    );
  }

  /** @returns {number} Position of the active file within #videoFiles, or -1. */
  #currentListPosition() {
    return this.#videoFiles.findIndex((file) => Number(file?.index) === this.#currentFileIndex);
  }

  #updateMetadata() {
    const file = this.#videoFiles.find((entry) => Number(entry?.index) === this.#currentFileIndex);
    const title =
      (typeof file?.relativePath === "string" && file.relativePath.length > 0 && file.relativePath) ||
      (typeof file?.name === "string" && file.name.length > 0 && file.name) ||
      MediaSessionBridge.APP_NAME;
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title,
        artist: MediaSessionBridge.APP_NAME
      });
    } catch {
      // MediaMetadata unsupported — ignore.
    }
  }

  #syncPlaybackState = () => {
    if (!this.#video) {
      return;
    }
    navigator.mediaSession.playbackState = this.#video.paused ? "paused" : "playing";
  };

  #syncPositionState = () => {
    if (!this.#video || typeof navigator.mediaSession.setPositionState !== "function") {
      return;
    }
    const duration = this.#video.duration;
    if (!Number.isFinite(duration) || duration <= 0) {
      return;
    }
    try {
      navigator.mediaSession.setPositionState({
        duration,
        position: Math.min(Math.max(0, this.#video.currentTime), duration),
        playbackRate: this.#video.playbackRate || 1
      });
    } catch {
      // Invalid state (e.g. position briefly past duration during a seek) — ignore.
    }
  };
}

function bootstrapMediaSession() {
  new MediaSessionBridge();
}

if (document.readyState !== "loading") {
  bootstrapMediaSession();
} else {
  document.addEventListener("DOMContentLoaded", bootstrapMediaSession, { once: true });
}
