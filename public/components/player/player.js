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
    document.addEventListener(PLAYER_EVENTS.OPEN_PLAYLIST, this.#onPlaylistOpen);
    document.addEventListener(PLAYER_EVENTS.CLOSE_PLAYLIST, this.#onPlaylistClose);
    document.addEventListener(PLAYER_EVENTS.FOCUS_PLAYLIST_TOGGLE, this.#onFocusPlaylistToggle);

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
