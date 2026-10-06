import { APP_EVENTS, MEDIA_INFO_EVENTS, PLAYER_EVENTS } from "../../shared/events.js";
import { episodeLabel, systemArtwork, workFor, workLine } from "../../domain/media-info.js";

/**
 * MediaSession integration.
 *
 * Bridges the OS-level media controls (lock screen, notification shade,
 * hardware/headset keys, Picture-in-Picture) to the app's event-driven model:
 * - metadata reflects the currently active video file;
 * - play / pause use the same explicit requests as the page controls;
 * - seek acts on the shared `<video>` element;
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
  /** What the metadata service said about the release; see MEDIA_INFO:CHANGED. */
  #media = null;
  /**
   * The poster chosen for the file being played. `systemArtwork` picks one of
   * several equally suitable posters at random, so it is asked once per file:
   * a later answer from the metadata service does not swap it.
   */
  #artwork = null;

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
    document.addEventListener(MEDIA_INFO_EVENTS.CHANGED, this.#onMediaInfo);
  }

  /** @param {Event} event */
  #onMediaInfo = (event) => {
    this.#media = event instanceof CustomEvent ? event.detail : null;
    // `null` starts a new release; nothing chosen for the last one applies.
    if (!this.#media) this.#artwork = null;
    this.#updateMetadata();
  };

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
    const next = Number.isInteger(fileIndex) ? fileIndex : -1;
    if (next !== this.#currentFileIndex) this.#artwork = null;
    this.#currentFileIndex = next;
    this.#updateMetadata();
    this.#updateTrackHandlers();
  };

  #onReset = () => {
    this.#videoFiles = [];
    this.#currentFileIndex = -1;
    this.#artwork = null;
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
      this.#requestPlayback("mediaplayrequest");
    });
    this.#setActionHandler("pause", () => {
      this.#requestPlayback("mediapauserequest");
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

  #requestPlayback(type) {
    this.#video?.dispatchEvent(new CustomEvent(type, {
      bubbles: true, composed: true, cancelable: true
    }));
  }

  /**
   * @param {MediaSessionAction} action
   * @param {MediaSessionActionHandler | null} handler
   */
  #setActionHandler(action, handler) {
    try {
      navigator.mediaSession.setActionHandler(action, handler);
    } catch {
      // silent-ok: the browser refusing an action it does not implement is the
      // ANSWER to whether it implements it. Playback is unaffected; only the
      // system's own media controls offer one button fewer.
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
    const fileName =
      (typeof file?.relativePath === "string" && file.relativePath.length > 0 && file.relativePath) ||
      (typeof file?.name === "string" && file.name.length > 0 && file.name) ||
      MediaSessionBridge.APP_NAME;
    // The episode's name when it was matched, the work's when only that is
    // known, the file's own name otherwise.
    const work = workFor(this.#media, this.#currentFileIndex);
    const match = this.#media?.episodes?.[String(this.#currentFileIndex)] ?? null;
    const title = match ? episodeLabel(match, { withSeason: match.season }) : (workLine(work) ?? fileName);
    if (!this.#artwork?.length) this.#artwork = systemArtwork(this.#media, this.#currentFileIndex);
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title,
        artist: match ? (workLine(work) ?? MediaSessionBridge.APP_NAME) : MediaSessionBridge.APP_NAME,
        artwork: this.#artwork.map(({ src, sizes, type }) => ({ src, sizes, type: type ?? (src.endsWith(".png") ? "image/png" : "image/jpeg") }))
      });
    } catch {
      // silent-ok: as above — the title shown by the operating system's media
      // controls is decoration over playback that continues either way.
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
      // silent-ok: the position is rejected exactly when it is momentarily
      // inconsistent — past the duration mid-seek — and the next update, a
      // moment later, carries a valid one.
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
