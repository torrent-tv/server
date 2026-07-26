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
    bufferingPeers: "#player__buffering-peers",
    share: "#player__share",
    shareMenu: "#player__share-menu",
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
  #bufferingPeers;
  #share;
  #shareMenu;
  /** @type {string} Shareable URL for the current source (empty = nothing to share). */
  #shareUrl = "";
  /** @type {ReturnType<typeof setTimeout> | null} Copied-feedback reset timer. */
  #shareCopiedTimer = null;
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
   * Show/hide the transient buffering/seeking indicator (data starvation): the
   * spinner, plus an info pill (peers, download speed, seconds ready) once stats
   * arrive. The pill text is pre-formatted by the loading component, which owns
   * the stats poll.
   *
   * @param {CustomEvent} event
   */
  #onSetBuffering = (event) => {
    const detail = event instanceof CustomEvent ? event.detail : null;
    if (detail?.active === true) {
      this.#buffering.hidden = false;
      const text = typeof detail?.text === "string" ? detail.text : "";
      if (text.length > 0) {
        this.#bufferingPeers.textContent = text;
        this.#bufferingPeers.style.visibility = "visible";
      } else {
        // Keep the pill in the layout — a non-breaking space reserves its line
        // and `visibility:hidden` (not display:none) keeps its box — so the
        // centered spinner does not jump when the peer count appears/disappears.
        this.#bufferingPeers.textContent = " ";
        this.#bufferingPeers.style.visibility = "hidden";
      }
      return;
    }
    this.#hideBuffering();
  };

  #hideBuffering() {
    this.#buffering.hidden = true;
    // The whole overlay is display:none while off; keep the pill reserved +
    // invisible so it never causes a layout jump when it reappears.
    this.#bufferingPeers.style.visibility = "hidden";
    this.#bufferingPeers.textContent = " ";
  }

  /**
   * Receive the shareable URL for the current source (a `?magnet=…` / `?torrent=…`
   * link the address bar no longer shows once loading cleaned it). An empty
   * value hides the button.
   *
   * @param {CustomEvent} event
   */
  #onSetShareLink = (event) => {
    const detail = event instanceof CustomEvent ? event.detail : null;
    const url = typeof detail?.url === "string" ? detail.url : "";
    this.#shareUrl = url;
    this.#share.hidden = url.length === 0;
  };

  /** Open (or toggle) the share menu, positioned over the share button. */
  #onShareClick = () => {
    if (this.#shareUrl.length === 0) {
      return;
    }
    if (this.#shareMenu.matches(":popover-open")) {
      this.#shareMenu.hidePopover();
      return;
    }
    const rect = this.#share.getBoundingClientRect();
    // Right-align to the button (it sits near the control bar's right edge, so
    // extending leftward keeps the menu on screen) and sit just above it.
    this.#shareMenu.style.left = "auto";
    this.#shareMenu.style.right = `${Math.max(0, window.innerWidth - rect.right)}px`;
    this.#shareMenu.style.top = `${rect.top}px`;
    this.#shareMenu.style.transform = "translateY(-100%) translateY(-0.5rem)";
    try {
      this.#shareMenu.showPopover();
    } catch {
      // Already open / unsupported — no-op.
    }
  };

  /** Copy the chosen share link (from start, or carrying the current time). */
  #onShareMenuClick = async (event) => {
    const target = event.target;
    const item = target instanceof Element ? target.closest("button[data-share]") : null;
    if (!item) {
      return;
    }
    const url = this.#buildShareUrl(item.dataset.share === "currentTime");
    try {
      this.#shareMenu.hidePopover();
    } catch {
      // ignore
    }
    try {
      await navigator.clipboard.writeText(url);
      this.#flashShareCopied();
    } catch {
      // Clipboard blocked (permissions / insecure context) — no-op.
    }
  };

  /**
   * The share URL, optionally with the current playback position appended as
   * `&currentTime=<seconds>` so the recipient resumes there. The query name
   * matches `video.currentTime` — the same name is used across every layer.
   *
   * @param {boolean} withCurrentTime
   * @returns {string}
   */
  #buildShareUrl(withCurrentTime) {
    if (!withCurrentTime) {
      return this.#shareUrl;
    }
    const currentTime = Math.floor(this.#video instanceof HTMLVideoElement ? this.#video.currentTime : 0);
    if (!Number.isFinite(currentTime) || currentTime <= 0) {
      return this.#shareUrl;
    }
    const separator = this.#shareUrl.includes("?") ? "&" : "?";
    return `${this.#shareUrl}${separator}currentTime=${currentTime}`;
  }

  /** Brief "copied" affordance on the share button. */
  #flashShareCopied() {
    this.#share.classList.add("player__button--copied");
    this.#share.setAttribute("aria-label", "Link copied");
    if (this.#shareCopiedTimer !== null) {
      clearTimeout(this.#shareCopiedTimer);
    }
    this.#shareCopiedTimer = setTimeout(() => {
      this.#share.classList.remove("player__button--copied");
      this.#share.setAttribute("aria-label", "Copy a share link for what you are watching");
      this.#shareCopiedTimer = null;
    }, 1500);
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
    this.#bufferingPeers = document.querySelector(Player.SELECTOR.bufferingPeers);
    this.#share = document.querySelector(Player.SELECTOR.share);
    this.#shareMenu = document.querySelector(Player.SELECTOR.shareMenu);

    if (
      !this.#root || !this.#controller || !this.#video || !this.#playlistToggle ||
      !this.#closeButton || !this.#settingsButton || !this.#settingsAudioItem || !this.#audioMenu ||
      !this.#settingsQualityItem || !this.#qualityMenu || !this.#buffering || !this.#bufferingPeers ||
      !this.#share || !this.#shareMenu
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
    document.addEventListener(PLAYER_EVENTS.SET_SHARE_LINK, this.#onSetShareLink);
    this.#share.addEventListener("click", this.#onShareClick);
    this.#shareMenu.addEventListener("click", this.#onShareMenuClick);

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
