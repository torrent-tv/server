import { APP_EVENTS, ERROR_EVENTS, LOADING_EVENTS, PLAYER_EVENTS, TORRENT_EVENTS } from "../../shared/events.js";

/**
 * Application orchestration finite state machine.
 *
 * This module does not manage DOM directly for view components.
 * It reacts to domain events and emits view-state events.
 */
class TorrentTV {
  static STATE = {
    IDLE: "IDLE",
    PROCESSING: "PROCESSING",
    PLAYING: "PLAYING",
    ERROR: "ERROR"
  };

  static TRANSITIONS = {
    [TorrentTV.STATE.IDLE]: [TorrentTV.STATE.PROCESSING, TorrentTV.STATE.ERROR],
    [TorrentTV.STATE.PROCESSING]: [TorrentTV.STATE.PLAYING, TorrentTV.STATE.ERROR, TorrentTV.STATE.IDLE],
    [TorrentTV.STATE.PLAYING]: [TorrentTV.STATE.PROCESSING, TorrentTV.STATE.ERROR, TorrentTV.STATE.IDLE],
    [TorrentTV.STATE.ERROR]: [TorrentTV.STATE.PROCESSING, TorrentTV.STATE.IDLE]
  };

  static MESSAGES = {
    errorTitle: "Error",
    alreadyProcessing: "Already processing another .torrent file.",
    playbackFailed: (message) =>
      typeof message === "string" && message.trim().length > 0 ? message : "Playback failed.",
    playbackStarted: "Playback started.",
    playbackPreparing: "Preparing playback..."
  };

  #state = TorrentTV.STATE.IDLE;
  #isBusy = false;
  /** @type {number} Number of video files in the currently loaded torrent. */
  #videoCount = 0;

  /** @param {CustomEvent} event */
  #onTorrentFileDetailsReady = (event) => {
    const payload = event instanceof CustomEvent ? event.detail : null;
    const file = payload?.file;
    const torrentBytes = payload?.torrentBytes;
    const meta = payload?.meta;
    const mediaFiles = payload?.mediaFiles;
    if (!(file instanceof File) || !(torrentBytes instanceof Uint8Array) || !meta || typeof meta !== "object") {
      return;
    }
    if (this.#isBusy) {
      this.#showError(TorrentTV.MESSAGES.alreadyProcessing);
      return;
    }
    this.#videoCount = Array.isArray(mediaFiles?.video) ? mediaFiles.video.length : 0;

    this.#transitionTo(TorrentTV.STATE.PROCESSING);
    this.#isBusy = true;
    document.dispatchEvent(
      new CustomEvent(LOADING_EVENTS.SHOW, {
        detail: {
          fileName: file.name,
          status: TorrentTV.MESSAGES.playbackPreparing,
          progress: 0
        }
      })
    );

    document.dispatchEvent(
      new CustomEvent(LOADING_EVENTS.PROCESS_PLAYBACK, {
        detail: { file, torrentBytes, meta, mediaFiles }
      })
    );
  };

  /** @param {CustomEvent} event */
  #onPlaybackReady = () => {
    this.#transitionTo(TorrentTV.STATE.PLAYING);
    this.#isBusy = false;
    this.#showPlayer();
    this.#setLoadingStatus(TorrentTV.MESSAGES.playbackStarted);
  };

  /** @param {CustomEvent} event */
  #onPlaybackFailed = (event) => {
    const payload = event instanceof CustomEvent ? event.detail : null;
    const description =
      typeof payload?.description === "string" ? payload.description : TorrentTV.MESSAGES.playbackFailed("");
    this.#transitionTo(TorrentTV.STATE.ERROR);
    this.#isBusy = false;
    this.#showError(TorrentTV.MESSAGES.playbackFailed(description));
  };

  #onAppReset = () => {
    this.#isBusy = false;
    this.#videoCount = 0;
    this.#transitionTo(TorrentTV.STATE.IDLE);
  };

  constructor () {
    this.#setupEventHandlers();
  }

  #setupEventHandlers = () => {
    document.addEventListener(TORRENT_EVENTS.FILE_DETAILS_READY, this.#onTorrentFileDetailsReady);
    document.addEventListener(LOADING_EVENTS.PLAYBACK_READY, this.#onPlaybackReady);
    document.addEventListener(LOADING_EVENTS.PLAYBACK_FAILED, this.#onPlaybackFailed);
    document.addEventListener(APP_EVENTS.RESET_TO_PICKER, this.#onAppReset);
    document.addEventListener(APP_EVENTS.BACK_TO_PLAYLIST, () => {
      this.#isBusy = false;
      this.#transitionTo(TorrentTV.STATE.PLAYING);
    });
  };

  /**
   * @param {string} nextState
   */
  #transitionTo(nextState) {
    if (nextState === this.#state) {
      return;
    }
    const allowed = TorrentTV.TRANSITIONS[this.#state] ?? [];
    if (!allowed.includes(nextState)) {
      throw new Error(`Invalid state transition: ${this.#state} -> ${nextState}`);
    }
    this.#state = nextState;
  }

  /** @param {string} value */
  #setLoadingStatus(value) {
    document.dispatchEvent(
      new CustomEvent(LOADING_EVENTS.SET_STATUS, {
        detail: { value }
      })
    );
  }

  /** @param {string} description */
  #showError(description) {
    this.#transitionTo(TorrentTV.STATE.ERROR);
    const backEvent = this.#videoCount > 1 ? APP_EVENTS.BACK_TO_PLAYLIST : APP_EVENTS.RESET_TO_PICKER;
    document.dispatchEvent(
      new CustomEvent(ERROR_EVENTS.SHOW, {
        detail: {
          title: TorrentTV.MESSAGES.errorTitle,
          description,
          backEvent
        }
      })
    );
  }

  #showPlayer() {
    document.dispatchEvent(new CustomEvent(PLAYER_EVENTS.SHOW));
  }
}

function bootstrapTorrentTv() {
  new TorrentTV();
}

if (document.readyState !== "loading") {
  bootstrapTorrentTv();
} else {
  document.addEventListener("DOMContentLoaded", bootstrapTorrentTv, { once: true });
}
