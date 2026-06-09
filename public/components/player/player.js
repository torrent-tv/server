import { APP_EVENTS, ERROR_EVENTS, LOADING_EVENTS, PLAYER_EVENTS } from "../../shared/events.js";

/**
 * Player view.
 *
 * Responsibilities:
 * - Manage player visibility.
 * - Expose video element reference via `PLAYER:READY`.
 */
export class Player {
  static SELECTOR = {
    root: "#player",
    video: "#player__video",
    resetButton: "#player__reset",
    playlistToggle: "#player__playlist-toggle",
  };

  static CLASSES = {
    isPlaylistOpen: "player--playlist",
    isPaused: "player--pause",
    isAnimated: "player--animated",
  };

  static MESSAGES = {
    missingDomNodes: "Player component DOM nodes are missing."
  };

  #root;
  #video;
  #playlistToggle;
  #resetButton;

  #onShow = () => {
    this.visible = true;
    // Start playback only now, when the player is actually revealed — not during
    // the loading / pre-buffer screen. This guarantees the first frame and the
    // audio start together (previously hls.js auto-played under the loading
    // overlay, so audio was heard while only the buffering UI was visible).
    // On iOS autoplay is blocked outside a user gesture; play() rejects and the
    // user starts it from the native controls — harmless, hence the catch.
    if (this.#video instanceof HTMLVideoElement) {
      const started = this.#video.play();
      if (started && typeof started.catch === "function") {
        started.catch(() => undefined);
      }
    }
  };

  #onRequestReady = () => {
    this.#emitReady();
  };

  #onLoadingShow = () => {
    this.#closePlaylist();
    this.visible = false;
  };

  #onErrorShow = () => {
    this.#closePlaylist();
    this.#video.pause();
    this.#video.removeAttribute("src");
    this.#video.load();
    this.visible = false;
  };

  #onAppReset = () => {
    this.#closePlaylist();
    this.#video.pause();
    this.#video.removeAttribute("src");
    this.#video.load();
    this.visible = false;
  };

  #onBackToPlaylist = () => {
    this.visible = true;
    this.#root.classList.add(Player.CLASSES.isAnimated);
    this.#root.classList.add(Player.CLASSES.isPlaylistOpen);
    document.dispatchEvent(new CustomEvent(PLAYER_EVENTS.OPEN_PLAYLIST));
  };

  /** @param {CustomEvent} event */
  #onSetMediaFiles = (event) => {
    const detail = event instanceof CustomEvent ? event.detail : null;
    const count =
      (Array.isArray(detail?.video) ? detail.video.length : 0) +
      (Array.isArray(detail?.audio) ? detail.audio.length : 0) +
      (Array.isArray(detail?.subtitles) ? detail.subtitles.length : 0);
    // With a single media file there is nothing to switch between, so hide the
    // playlist button entirely.
    const target = this.#playlistToggle.closest("li") ?? this.#playlistToggle;
    target.hidden = count <= 1;
  };

  constructor() {
    this.#root = document.querySelector(Player.SELECTOR.root);
    this.#video = document.querySelector(Player.SELECTOR.video);
    this.#playlistToggle = document.querySelector(Player.SELECTOR.playlistToggle);
    this.#resetButton = document.querySelector(Player.SELECTOR.resetButton);

    if (!this.#root || !this.#video || !this.#playlistToggle || !this.#resetButton) {
      throw new Error(Player.MESSAGES.missingDomNodes);
    }

    this.#setupEventHandlers();
    this.#emitReady();
  }

  #setupEventHandlers() {
    document.addEventListener(PLAYER_EVENTS.SHOW, this.#onShow);
    document.addEventListener(PLAYER_EVENTS.REQUEST_READY, this.#onRequestReady);
    document.addEventListener(LOADING_EVENTS.SHOW, this.#onLoadingShow);
    document.addEventListener(ERROR_EVENTS.SHOW, this.#onErrorShow);
    document.addEventListener(APP_EVENTS.RESET_TO_PICKER, this.#onAppReset);
    document.addEventListener(APP_EVENTS.BACK_TO_PLAYLIST, this.#onBackToPlaylist);
    document.addEventListener(PLAYER_EVENTS.OPEN_PLAYLIST, this.#onPlaylistOpen);
    document.addEventListener(PLAYER_EVENTS.CLOSE_PLAYLIST, this.#onPlaylistClose);
    document.addEventListener(PLAYER_EVENTS.FOCUS_PLAYLIST_TOGGLE, this.#onFocusPlaylistToggle);
    document.addEventListener(PLAYER_EVENTS.SET_MEDIA_FILES, this.#onSetMediaFiles);

    this.#root.addEventListener('transitionend', (event) => {
      if (event.target !== this.#root || event.propertyName !== 'translate') return;
      this.#root.classList.remove(Player.CLASSES.isAnimated);
    });

    this.#resetButton.addEventListener("click", this.#resetHandler);
    this.#playlistToggle.addEventListener("click", this.#togglePlaylist);
    this.#video.addEventListener('play', this.#onStartPlaying);
    this.#video.addEventListener('pause', this.#onPausePlaying);
  }

  #onStartPlaying = () => {
    this.#root.classList.toggle(Player.CLASSES.isPaused, false);
  };

  #onPausePlaying = () => {
    this.#root.classList.toggle(Player.CLASSES.isPaused, true);
  };

  #resetHandler = () => {
    document.dispatchEvent(new CustomEvent(APP_EVENTS.RESET_TO_PICKER));
  };

  #togglePlaylist = () => {
    const isPlaylistOpen = this.#root.classList.contains(Player.CLASSES.isPlaylistOpen);
    this.#root.classList.add(Player.CLASSES.isAnimated);
    this.#root.classList.toggle(Player.CLASSES.isPlaylistOpen, !isPlaylistOpen);
    const event = isPlaylistOpen
      ? new CustomEvent(PLAYER_EVENTS.CLOSE_PLAYLIST)
      : new CustomEvent(PLAYER_EVENTS.OPEN_PLAYLIST);
    document.dispatchEvent(event);
  };

  #onPlaylistOpen = () => {
    this.#root.classList.toggle(Player.CLASSES.isPlaylistOpen, true);
    this.#playlistToggle.setAttribute("aria-expanded", "true");
    this.#video.inert = true;
    this.#resetButton.inert = false;
    this.#playlistToggle.inert = false;
  };

  #onPlaylistClose = () => {
    this.#root.classList.toggle(Player.CLASSES.isPlaylistOpen, false);
    this.#playlistToggle.setAttribute("aria-expanded", "false");
    this.#video.inert = false;
    this.#resetButton.inert = false;
    this.#playlistToggle.inert = false;
  };

  #onFocusPlaylistToggle = () => {
    this.#playlistToggle.focus({ preventScroll: true });
  };

  #closePlaylist = () => {
    if (this.#root.classList.contains(Player.CLASSES.isPlaylistOpen)) {
      this.#root.classList.add(Player.CLASSES.isAnimated);
      this.#root.classList.remove(Player.CLASSES.isPlaylistOpen);
    }
    document.dispatchEvent(new CustomEvent(PLAYER_EVENTS.CLOSE_PLAYLIST));
  };

  #emitReady() {
    document.dispatchEvent(
      new CustomEvent(PLAYER_EVENTS.READY, {
        detail: { videoElement: this.#video }
      })
    );
  }

  /** @param {boolean} value */
  set visible(value) {
    // Invariant: nothing plays while the player is hidden. A hidden <video>
    // (display:none) still emits audio, so pause whenever we hide — covers the
    // loading/pre-buffer screen, errors and reset. Playback is (re)started only
    // in #onShow when the player is actually revealed.
    if (!value && this.#video instanceof HTMLVideoElement && !this.#video.paused) {
      this.#video.pause();
    }
    this.#root.hidden = !value;
    this.#root.inert = !value;
  }
}

function bootstrapPlayer() {
  new Player();
}

if (document.readyState !== "loading") {
  bootstrapPlayer();
} else {
  document.addEventListener("DOMContentLoaded", bootstrapPlayer, { once: true });
}
