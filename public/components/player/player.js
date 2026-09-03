import { APP_EVENTS, PLAYER_EVENTS } from "../../shared/events.js";
import {
  APP_VIEW,
  MEDIA_INTENT,
  acceptsPlaybackInput,
  isWaiting,
  mediaIntentForState,
  viewForState
} from "../../domain/app-state.js";
import { StateDerivedView } from "../../shared/state-derived-view.js";
import { pauseWithoutIntent } from "../../domain/playback-intent.js";
import { bufferedAheadSeconds, fillRateFromSamples, withSample } from "../../domain/buffer-metrics.js";

/**
 * Player view.
 *
 * Responsibilities:
 * - Manage player visibility.
 * - Expose video element reference via `PLAYER:READY`.
 * - Wire the custom control-bar buttons (close, playlist) that media-chrome
 *   does not provide out of the box.
 */
export class Player extends StateDerivedView {
  static SELECTOR = {
    root: "#player",
    controller: "#player__controller",
    video: "#player__video",
    playButton: "#player__play",
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
  #playButton;
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

  /**
   * Recent buffer readings, for the fill rate. Held here because this component
   * owns the element: how much is buffered and how fast it is filling are facts
   * about the media, and a fact has one owner.
   *
   * @type {Array<{ atMs: number, aheadSeconds: number }>}
   */
  #bufferSamples = [];

  /**
   * Ticks while the viewer is waiting. The element's own events only fire once
   * it has a source and data moving, so through the whole of a cold open there
   * were no readings at all — and with nothing measured the estimate has
   * nothing to say, which is why the one figure the viewer actually wants was
   * missing exactly when they were waiting for it. An unattached element
   * reading zero is a true reading, not a guess.
   *
   * @type {number | null}
   */
  #bufferTimer = null;

  /** Ticks while the picture is meant to be moving. See #reportDecodedFrames. */
  #decodeTimer = null;

  /**
   * The track set the proxy said this session would carry, or null before it
   * has said. Compared against what actually arrives — see #reportDecodedFrames.
   *
   * @type {{ video: boolean, audio: boolean } | null}
   */
  #declaredTracks = null;
  // The settings button is shared by the Audio and Quality submenus; it shows
  // when either has something to offer.
  #audioAvailable = false;
  #qualityAvailable = false;

  /**
   * The state currently applied. Held because a media element's own events
   * arrive between transitions and have to be answered against the state that
   * is in force at that moment — see #onPlayAttempt.
   *
   * @type {string}
   */
  #state = "";

  /**
   * The player derives itself from the application's state and from nothing
   * else. It is not told to appear: under a Moore machine an output is a
   * function of the state, so being on screen is read from the state rather
   * than commanded on the edge that led there. The design this replaces was
   * commanded — and four flows (quality switch, audio switch, reconnect, Retry)
   * re-showed the loading view with no transition at all, so the state said one
   * thing and the screen another with nothing able to notice.
   *
   * @param {string} state
   * @param {boolean} belongsOnScreen
   * @returns {void}
   */
  applyAppState(state, belongsOnScreen) {
    if (!belongsOnScreen && this.onScreen) {
      // Leaving the player entirely — the picker or the error screen. Let go of
      // the media: a hidden <video> still holds its source and still emits
      // audio.
      this.#closePlaylist();
      this.#hideBuffering();
      pauseWithoutIntent(this.#video);
      this.#video.removeAttribute("src");
      this.#video.load();
    }
    this.#state = state;
    super.applyAppState(state, belongsOnScreen);
    if (belongsOnScreen) {
      this.#logEvt(`view=player shown state=${state}`);
    }
    // Whether the viewer is waiting is a property of the state. The text beside
    // the spinner is not — it is measured (peers, speed) and keeps arriving on
    // PLAYER:SET_BUFFERING.
    this.#buffering.hidden = !(belongsOnScreen && isWaiting(state));
    this.#measureWhileWaiting(belongsOnScreen && isWaiting(state));
    this.#applyPlaybackInput(state);
    this.#applyMediaIntent(state);
  }

  /**
   * Whether the play control accepts input, applied to every way there is of
   * starting the picture: the button, the keyboard, and a press on the frame.
   * All three exist, and blocking one of them leaves the other two — the
   * controller mounts a gesture receiver of its own and binds space by default.
   *
   * The state where they are refused is the hold a change the viewer asked for
   * puts the picture in. Playing on through it means watching in the language
   * they have just replaced and then going back over it, which is the report
   * this answers.
   *
   * @param {string} state
   * @returns {void}
   */
  #applyPlaybackInput(state) {
    const accepts = acceptsPlaybackInput(state);
    this.#playButton.toggleAttribute("disabled", !accepts);
    this.#controller.toggleAttribute("nohotkeys", !accepts);
    this.#controller.toggleAttribute("gesturesdisabled", !accepts);
  }

  /**
   * The picture started while the state forbids it. Refusing the controls is
   * what a viewer meets; this is the guarantee behind it, for every other way
   * an element can be started — a script, a remote control, a browser's own
   * media keys, an `autoplay` after a source change.
   *
   * Marked as our pause, so the machine does not read it as the viewer stopping
   * playback: that is precisely the confusion this whole change removes.
   *
   * @returns {void}
   */
  #onPlayAttempt = () => {
    if (acceptsPlaybackInput(this.#state)) {
      return;
    }
    this.#logEvt(`player.pause reason=held state=${this.#state}`);
    pauseWithoutIntent(this.#video);
  };

  /**
   * Start or stop the element according to what the state implies — never
   * according to which edge arrived.
   *
   * `LEAVE` is the third answer and the reason this is not a boolean: while a
   * frame is being waited for, both commands are wrong. A stall during playback
   * must not be paused, and a scrub while paused must not be started.
   *
   * @param {string} state
   * @returns {void}
   */
  #applyMediaIntent(state) {
    if (!(this.#video instanceof HTMLVideoElement)) {
      return;
    }
    const intent = mediaIntentForState(state);
    if (intent === MEDIA_INTENT.PLAY) {
      // Playback starts when the machine says the picture is meant to move,
      // which is the moment the stream became usable — not while the waiting
      // view is up. That ordering is what keeps the first frame and the audio
      // together; hls.js auto-playing under the overlay used to be heard before
      // anything was shown. On iOS autoplay outside a user gesture is refused
      // and the viewer starts it from the play button, hence the catch.
      this.#logEvt("player.play reason=state");
      const started = this.#video.play();
      if (started && typeof started.catch === "function") {
        started.catch((error) => {
          // A refused autoplay leaves the element paused, which raises a `pause`
          // event — and that event was being read as the VIEWER stopping
          // playback. The machine went to PAUSED, resumed, called play() again,
          // was refused again: measured 2026-08-09 as a loop of
          // `play reason=state` / `PAUSED on PAUSED_BY_VIEWER` / `ADVANCING on
          // RESUMED`, which is exactly why a cold open never started until a
          // seek — a seek is a user gesture, and a gesture lifts the refusal.
          // Marked as ours so it is not mistaken for a decision, and said out
          // loud so it is never again invisible.
          pauseWithoutIntent(this.#video);
          console.warn(
            `[evt] player.play refused: ${error?.name ?? "error"} — ` +
            "the browser will not start playback without a gesture from the viewer"
          );
        });
      }
      return;
    }
    if (intent === MEDIA_INTENT.PAUSE && !this.#video.paused) {
      this.#logEvt(`player.pause reason=state=${state}`);
      pauseWithoutIntent(this.#video);
    }
  }

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

  /**
   * Measure the element and publish what it says. Driven by the element's own
   * events, so a reading is only taken when something about the buffer can
   * actually have changed.
   */
  /**
   * A seek throws the buffer away, so readings taken across one are not a
   * measurement of anything — the drop is the flush, not the pipeline slowing
   * down. Trusted as a rate it produced 0.08x, and dividing the shortfall by
   * that announced a 296-second wait for one that lasted 1.0 s (measured
   * 2026-08-09; another read 719.7 s against 11.2 s).
   *
   * @returns {void}
   */
  #onSeeking = () => {
    this.#bufferSamples = [];
  };

  #onBufferChanged = () => {
    if (!(this.#video instanceof HTMLVideoElement)) {
      return;
    }
    const aheadSeconds = bufferedAheadSeconds(this.#video);
    this.#bufferSamples = withSample(this.#bufferSamples, {
      atMs: Date.now(),
      aheadSeconds,
      // The playhead, so the rate can tell media that was PLAYED from time that
      // merely passed. A stalled element is not paused and plays nothing.
      playheadSeconds: this.#video.currentTime
    });
    document.dispatchEvent(new CustomEvent(PLAYER_EVENTS.BUFFER, {
      detail: {
        bufferedAhead: aheadSeconds,
        // Whether the picture is moving decides whether playback consumption
        // counts toward the rate. This element knows; nothing else does.
        fillRate: fillRateFromSamples(this.#bufferSamples)
      }
    }));
  };

  /**
   * Keep a reading arriving for as long as the viewer is waiting, and stop the
   * moment they are not.
   *
   * @param {boolean} waiting
   * @returns {void}
   */
  /**
   * Whether the picture is actually being decoded, said plainly.
   *
   * A track we chose to COPY is one we told ourselves the browser can play. If
   * that judgement was wrong the result is a black frame with working sound —
   * and from every other measurement it is indistinguishable from data arriving
   * too slowly, which is a completely different fault with a completely
   * different fix. Frames decoded is the one reading that separates them: time
   * advancing with the frame counter at zero can only mean the picture was
   * never decodable.
   *
   * @returns {void}
   */
  #reportDecodedFrames = () => {
    if (!(this.#video instanceof HTMLVideoElement) || this.#video.paused) {
      return;
    }
    const quality = typeof this.#video.getVideoPlaybackQuality === "function"
      ? this.#video.getVideoPlaybackQuality()
      : null;
    const frames = quality?.totalVideoFrames ?? null;
    const line =
      `decode t=${this.#video.currentTime.toFixed(1)}s ` +
      `size=${this.#video.videoWidth}x${this.#video.videoHeight} ` +
      `frames=${frames ?? "n/a"} dropped=${quality?.droppedVideoFrames ?? "n/a"} ` +
      `readyState=${this.#video.readyState}`;
    // What arrived, against what the proxy said it would send. The two are
    // stated separately on purpose: "no picture" alone cannot tell a file that
    // genuinely has no video from a session that lost the track on the way, and
    // those are opposite problems.
    const hasPicture = this.#video.videoWidth > 0 && (frames ?? 0) > 0;
    const declared = this.#declaredTracks;
    if (this.#video.currentTime > 3 && declared !== null && declared.video && !hasPicture) {
      console.warn(
        `[evt] ${line} — the proxy declared video and audio, this element has audio only: ` +
        "a track was lost between the encoder and the browser"
      );
      return;
    }
    if (this.#video.currentTime > 3 && !hasPicture) {
      console.warn(
        `[evt] ${line} — no picture decoded` +
        (declared === null ? " (the proxy declared nothing to compare against)" : " (no video was declared)")
      );
      return;
    }
    this.#logEvt(line);
  };

  #measureWhileWaiting(waiting) {
    if (waiting && this.#bufferTimer === null) {
      this.#onBufferChanged();
      this.#bufferTimer = window.setInterval(this.#onBufferChanged, 500);
      return;
    }
    if (!waiting && this.#decodeTimer === null) {
      // Only while the picture is meant to be moving.
      this.#decodeTimer = window.setInterval(this.#reportDecodedFrames, 5_000);
      return;
    }
    if (!waiting && this.#bufferTimer !== null) {
      window.clearInterval(this.#bufferTimer);
      this.#bufferTimer = null;
    }
    if (waiting && this.#decodeTimer !== null) {
      window.clearInterval(this.#decodeTimer);
      this.#decodeTimer = null;
    }
  }

  #onDeclaredTracks = (event) => {
    const detail = event instanceof CustomEvent ? event.detail : null;
    this.#declaredTracks = detail && typeof detail === "object"
      ? { video: detail.video === true, audio: detail.audio === true }
      : null;
    this.#logEvt(`declared tracks video=${this.#declaredTracks?.video} audio=${this.#declaredTracks?.audio}`);
  };

  #onRequestReady = () => {
    this.#emitReady();
  };


  /**
   * Show/hide the transient buffering/seeking indicator (data starvation): the
   * spinner, plus an info pill (peers, download speed, seconds ready) once stats
   * arrive. The pill text is pre-formatted by the loading component, which owns
   * the stats poll.
   *
   * @param {CustomEvent} event
   */
  #hideBuffering() {
    this.#buffering.hidden = true;
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
      // silent-ok: the menu is already open, or this browser has no popover —
      // in both cases the state the caller wanted is the state that holds.
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
      // silent-ok: closing a menu that is already closed. The click that got
      // here is served either way.
    }
    try {
      await navigator.clipboard.writeText(url);
      this.#flashShareCopied();
    } catch (error) {
      // The viewer pressed a button and nothing happened: no link on the
      // clipboard, and no sign of why. This is the rule's second half — a
      // branch that changes what the viewer sees — so it is said out loud and
      // names the condition, which is nearly always a refused permission or a
      // page that is not a secure context.
      console.warn(
        `[torrent-tv][share] the link could not be copied: ${error instanceof Error ? error.message : String(error)}`
      );
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
    super((state) => viewForState(state) === APP_VIEW.PLAYER);
    this.#root = document.querySelector(Player.SELECTOR.root);
    this.#controller = document.querySelector(Player.SELECTOR.controller);
    this.#video = document.querySelector(Player.SELECTOR.video);
    if (this.#video instanceof HTMLVideoElement) {
      // Every event after which the buffer can differ. `progress` covers data
      // arriving, `timeupdate` covers it being consumed, and the last three are
      // the moments a viewer is most likely to be looking at the figure.
      for (const name of ["progress", "timeupdate", "waiting", "seeking", "seeked"]) {
        this.#video.addEventListener(name, this.#onBufferChanged);
      }
      // Registered AFTER, so the history is thrown away before the reading this
      // same event triggers is taken — otherwise the first sample of the new
      // position is compared against the old one across the flush.
      this.#video.addEventListener("seeking", this.#onSeeking);
      this.#video.addEventListener("play", this.#onPlayAttempt);
    }
    this.#playButton = document.querySelector(Player.SELECTOR.playButton);
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
      !this.#root || !this.#controller || !this.#video || !this.#playButton || !this.#playlistToggle ||
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
    document.addEventListener(PLAYER_EVENTS.REQUEST_READY, this.#onRequestReady);
    document.addEventListener(PLAYER_EVENTS.DECLARED_TRACKS, this.#onDeclaredTracks);
    document.addEventListener(APP_EVENTS.BACK_TO_PLAYLIST, this.#onBackToPlaylist);
    document.addEventListener(PLAYER_EVENTS.OPEN_PLAYLIST, this.#onPlaylistOpen);
    document.addEventListener(PLAYER_EVENTS.CLOSE_PLAYLIST, this.#onPlaylistClose);
    document.addEventListener(PLAYER_EVENTS.FOCUS_PLAYLIST_TOGGLE, this.#onFocusPlaylistToggle);
    document.addEventListener(PLAYER_EVENTS.SET_MEDIA_FILES, this.#onSetMediaFiles);
    document.addEventListener(PLAYER_EVENTS.SET_SHARE_LINK, this.#onSetShareLink);
    this.#share.addEventListener("click", this.#onShareClick);
    this.#shareMenu.addEventListener("click", this.#onShareMenuClick);

    this.#root.addEventListener('transitionend', (event) => {
      if (event.target !== this.#root || event.propertyName !== 'translate') return;
      this.#root.classList.remove(Player.CLASSES.isAnimated);
    });

    this.#sendTheWholeViewFullscreen();
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

  /**
   * Send the whole player view fullscreen, not the media controller alone.
   *
   * The playlist drawer is the controller's SIBLING inside `<main id="player">`
   * — the two sit in one flex row that slides sideways to reveal the drawer. A
   * browser paints only the fullscreen element's own subtree, so with the
   * controller as that element the drawer was not on the screen at all: the
   * button worked and `player--playlist` was applied, and it opened where
   * nobody could see it. Reported 2026-08-31.
   *
   * Set as a PROPERTY rather than by the `fullscreenelement` attribute that
   * media-chrome documents. In 4.19.2 that attribute is absent from
   * `observedAttributes`, so the branch resolving it never runs — verified in a
   * browser: with the attribute in the markup, `controller.fullscreenElement`
   * still answered with the controller. The property setter is the only route
   * that works, and it clears the attribute itself.
   *
   * @returns {void}
   */
  #sendTheWholeViewFullscreen() {
    // The element must be upgraded before it has the setter; the module may not
    // have been evaluated yet when this component initialises.
    void customElements.whenDefined("media-controller").then(() => {
      this.#controller.fullscreenElement = this.#root;
    });
  }

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
      pauseWithoutIntent(this.#video);
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
