import { APP_EVENTS, ERROR_EVENTS, LOADING_EVENTS, PLAYER_EVENTS } from "../../shared/events.js";

/**
 * Player view.
 *
 * Responsibilities:
 * - Manage player visibility.
 * - Expose video element reference via `PLAYER:READY`.
 * - Wire the custom control-bar buttons (close, playlist) that media-chrome
 *   does not provide out of the box.
 */
export class Player {
  static SELECTOR = {
    root: "#player",
    controller: "#player__controller",
    video: "#player__video",
    closeButton: "#player__close",
    playlistToggle: "#player__playlist-toggle",
    settingsButton: "#player__settings-button",
    settingsAudioItem: "#player__settings-audio",
    audioMenu: "#player__audio-menu",
    settingsQualityItem: "#player__settings-quality",
    qualityMenu: "#player__quality-menu",
    buffering: "#player__buffering",
  };

  static CLASSES = {
    isPlaylistOpen: "player--playlist",
    isAnimated: "player--animated",
  };

  static MESSAGES = {
    missingDomNodes: "Player component DOM nodes are missing."
  };

  #root;
  #controller;
  #video;
  #playlistToggle;
  #closeButton;
  #settingsButton;
  #settingsAudioItem;
  #audioMenu;
  #settingsQualityItem;
  #qualityMenu;
  #buffering;
  // The settings button is shared by the Audio and Quality submenus; it shows
  // when either has something to offer.
  #audioAvailable = false;
  #qualityAvailable = false;

  #onShow = () => {
    this.#logEvt("view=player shown cause=PLAYER:SHOW");
    this.visible = true;
    // Start playback only now, when the player is actually revealed — not during
    // the loading / pre-buffer screen. This guarantees the first frame and the
    // audio start together (previously hls.js auto-played under the loading
    // overlay, so audio was heard while only the buffering UI was visible).
    // On iOS autoplay is blocked outside a user gesture; play() rejects and the
    // user starts it from the play button — harmless, hence the catch.
    if (this.#video instanceof HTMLVideoElement) {
      this.#logEvt("player.play reason=show");
      const started = this.#video.play();
      if (started && typeof started.catch === "function") {
        started.catch(() => undefined);
      }
    }
  };

  /**
   * Emit a timestamped `[evt]` diagnostic line (UTC, same zone as the proxy
   * logger). Temporary.
   *
   * @param {string} message
   * @returns {void}
   */
  #logEvt(message) {
    console.debug(`[evt] ${new Date().toISOString().slice(11, 23)} ${message}`);
  }

  #onRequestReady = () => {
    this.#emitReady();
  };

  #onLoadingShow = () => {
    this.#closePlaylist();
    this.#hideBuffering();
    this.visible = false;
  };

  #onErrorShow = () => {
    this.#closePlaylist();
    this.#hideBuffering();
    this.#video.pause();
    this.#video.removeAttribute("src");
    this.#video.load();
    this.visible = false;
  };

  #onAppReset = () => {
    this.#closePlaylist();
    this.#hideBuffering();
    this.#video.pause();
    this.#video.removeAttribute("src");
    this.#video.load();
    this.visible = false;
  };

  /**
   * Show/hide the transient buffering notice (data starvation). The message is
   * supplied by the loading component, which owns the peer-count lookup.
   *
   * @param {CustomEvent} event
   */
  #onSetBuffering = (event) => {
    const detail = event instanceof CustomEvent ? event.detail : null;
    if (detail?.active === true) {
      const message = typeof detail?.message === "string" && detail.message.trim().length > 0
        ? detail.message
        : "Buffering…";
      this.#buffering.textContent = message;
      this.#buffering.hidden = false;
      return;
    }
    this.#hideBuffering();
  };

  #hideBuffering() {
    this.#buffering.hidden = true;
    this.#buffering.textContent = "";
  }

  #onBackToPlaylist = () => {
    this.visible = true;
    this.#root.classList.add(Player.CLASSES.isAnimated);
    document.dispatchEvent(new CustomEvent(PLAYER_EVENTS.OPEN_PLAYLIST));
  };

  /** @param {CustomEvent} event */
  #onSetMediaFiles = (event) => {
    const detail = event instanceof CustomEvent ? event.detail : null;
    // The playlist only switches between VIDEO files, so its button depends on
    // the video count alone — audio/subtitle files must not make a single-video
    // torrent show a playlist there is nothing to switch to.
    const videoCount = Array.isArray(detail?.video) ? detail.video.length : 0;
    this.#playlistToggle.hidden = videoCount <= 1;
  };

  constructor() {
    this.#root = document.querySelector(Player.SELECTOR.root);
    this.#controller = document.querySelector(Player.SELECTOR.controller);
    this.#video = document.querySelector(Player.SELECTOR.video);
    this.#playlistToggle = document.querySelector(Player.SELECTOR.playlistToggle);
    this.#closeButton = document.querySelector(Player.SELECTOR.closeButton);
    this.#settingsButton = document.querySelector(Player.SELECTOR.settingsButton);
    this.#settingsAudioItem = document.querySelector(Player.SELECTOR.settingsAudioItem);
    this.#audioMenu = document.querySelector(Player.SELECTOR.audioMenu);
    this.#settingsQualityItem = document.querySelector(Player.SELECTOR.settingsQualityItem);
    this.#qualityMenu = document.querySelector(Player.SELECTOR.qualityMenu);
    this.#buffering = document.querySelector(Player.SELECTOR.buffering);

    if (
      !this.#root || !this.#controller || !this.#video || !this.#playlistToggle ||
      !this.#closeButton || !this.#settingsButton || !this.#settingsAudioItem || !this.#audioMenu ||
      !this.#settingsQualityItem || !this.#qualityMenu || !this.#buffering
    ) {
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
    document.addEventListener(PLAYER_EVENTS.SET_BUFFERING, this.#onSetBuffering);

    this.#root.addEventListener('transitionend', (event) => {
      if (event.target !== this.#root || event.propertyName !== 'translate') return;
      this.#root.classList.remove(Player.CLASSES.isAnimated);
    });

    this.#closeButton.addEventListener("click", this.#closeHandler);
    this.#playlistToggle.addEventListener("click", this.#togglePlaylist);
    this.#controller.addEventListener("click", this.#onControllerClick);
    document.addEventListener(PLAYER_EVENTS.SET_AUDIO_TRACKS, this.#onSetAudioTracks);
    this.#audioMenu.addEventListener("click", this.#onAudioMenuClick);
    document.addEventListener(PLAYER_EVENTS.SET_QUALITY_OPTIONS, this.#onSetQualityOptions);
    this.#qualityMenu.addEventListener("click", this.#onQualityMenuClick);
  }

  /**
   * The settings button is shown when either the Audio or the Quality submenu
   * has something to offer.
   */
  #updateSettingsVisibility() {
    this.#settingsButton.hidden = !(this.#audioAvailable || this.#qualityAvailable);
  }

  /**
   * Populate the audio submenu from the playback plan's track inventory.
   * The settings button and the Audio item stay hidden until a file actually
   * has more than one audio track.
   *
   * @param {CustomEvent} event
   */
  #onSetAudioTracks = (event) => {
    const detail = event instanceof CustomEvent ? event.detail : null;
    const tracks = Array.isArray(detail?.tracks) ? detail.tracks : [];
    const activeIndex = Number.isInteger(detail?.activeIndex) ? detail.activeIndex : 0;

    for (const item of this.#audioMenu.querySelectorAll("media-chrome-menu-item")) {
      item.remove();
    }

    const show = tracks.length > 1;
    this.#audioAvailable = show;
    this.#settingsAudioItem.hidden = !show;
    this.#updateSettingsVisibility();
    if (!show) {
      return;
    }

    for (const track of tracks) {
      const item = document.createElement("media-chrome-menu-item");
      item.setAttribute("type", "radio");
      item.dataset.audioTrackIndex = String(track.index);
      if (track.index === activeIndex) {
        item.setAttribute("checked", "");
      }
      item.textContent = track.label ?? `Track ${track.index + 1}`;
      this.#audioMenu.appendChild(item);
    }
  };

  /** @param {MouseEvent} event */
  #onAudioMenuClick = (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const item = target.closest("media-chrome-menu-item[data-audio-track-index]");
    if (!item || item.hasAttribute("checked")) return;
    for (const sibling of this.#audioMenu.querySelectorAll("media-chrome-menu-item")) {
      sibling.toggleAttribute("checked", sibling === item);
    }
    document.dispatchEvent(
      new CustomEvent(PLAYER_EVENTS.SELECT_AUDIO_TRACK, {
        detail: { trackIndex: Number(item.dataset.audioTrackIndex) }
      })
    );
  };

  /**
   * Populate the Quality submenu. Options are `{ height, label }`; `height: 0`
   * is Auto (the proxy's realtime budget). The item stays hidden unless there
   * is a real choice (Auto plus at least one forced resolution).
   *
   * @param {CustomEvent} event
   */
  #onSetQualityOptions = (event) => {
    const detail = event instanceof CustomEvent ? event.detail : null;
    const options = Array.isArray(detail?.options) ? detail.options : [];
    const activeHeight = Number.isInteger(detail?.activeHeight) ? detail.activeHeight : 0;

    for (const item of this.#qualityMenu.querySelectorAll("media-chrome-menu-item")) {
      item.remove();
    }

    const show = options.length > 1;
    this.#qualityAvailable = show;
    this.#settingsQualityItem.hidden = !show;
    this.#updateSettingsVisibility();
    if (!show) {
      return;
    }

    for (const option of options) {
      const item = document.createElement("media-chrome-menu-item");
      item.setAttribute("type", "radio");
      item.dataset.qualityHeight = String(option.height);
      if (option.height === activeHeight) {
        item.setAttribute("checked", "");
      }
      item.textContent = option.label;
      this.#qualityMenu.appendChild(item);
    }
  };

  /** @param {MouseEvent} event */
  #onQualityMenuClick = (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const item = target.closest("media-chrome-menu-item[data-quality-height]");
    if (!item || item.hasAttribute("checked")) return;
    for (const sibling of this.#qualityMenu.querySelectorAll("media-chrome-menu-item")) {
      sibling.toggleAttribute("checked", sibling === item);
    }
    document.dispatchEvent(
      new CustomEvent(PLAYER_EVENTS.SELECT_QUALITY, {
        detail: { height: Number(item.dataset.qualityHeight) }
      })
    );
  };

  #closeHandler = () => {
    document.dispatchEvent(new CustomEvent(APP_EVENTS.RESET_TO_PICKER));
  };

  #togglePlaylist = (event) => {
    // Keep the click from reaching #onControllerClick, which would treat it as
    // a click-outside and immediately re-close the playlist being opened.
    event.stopPropagation();
    const isPlaylistOpen = this.#root.classList.contains(Player.CLASSES.isPlaylistOpen);
    this.#root.classList.add(Player.CLASSES.isAnimated);
    const nextEvent = isPlaylistOpen
      ? new CustomEvent(PLAYER_EVENTS.CLOSE_PLAYLIST)
      : new CustomEvent(PLAYER_EVENTS.OPEN_PLAYLIST);
    document.dispatchEvent(nextEvent);
  };

  /**
   * While the playlist drawer is open, a click anywhere on the player surface
   * (outside the playlist itself) closes it — media gestures are disabled for
   * the duration, so the click cannot also toggle play/pause.
   */
  #onControllerClick = () => {
    if (!this.#root.classList.contains(Player.CLASSES.isPlaylistOpen)) return;
    this.#root.classList.add(Player.CLASSES.isAnimated);
    this.#closePlaylist();
  };

  #onPlaylistOpen = () => {
    this.#root.classList.toggle(Player.CLASSES.isPlaylistOpen, true);
    this.#playlistToggle.setAttribute("aria-expanded", "true");
    // Suppress the tap-to-pause gesture so a click that closes the drawer does
    // not also pause playback.
    this.#controller.setAttribute("gesturesdisabled", "");
  };

  #onPlaylistClose = () => {
    this.#root.classList.toggle(Player.CLASSES.isPlaylistOpen, false);
    this.#playlistToggle.setAttribute("aria-expanded", "false");
    this.#controller.removeAttribute("gesturesdisabled");
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
      this.#logEvt("player.pause reason=hidden");
      this.#video.pause();
    }
    if (!value) {
      this.#logEvt("view=player hidden");
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
