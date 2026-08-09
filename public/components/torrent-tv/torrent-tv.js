import { APP_EVENTS, ERROR_EVENTS, LOADING_EVENTS, PLAYER_EVENTS, TORRENT_EVENTS } from "../../shared/events.js";
import {
  APP_EVENT,
  APP_STATE,
  APP_SUPERSTATE,
  INITIAL_STATE,
  isWithin,
  nextState
} from "../../domain/app-state.js";

/**
 * The driver of the application state machine.
 *
 * It holds no rules. Every rule — which transitions exist, what each state
 * implies for the screen — lives in `domain/app-state.js`, where it is a pure
 * table and a set of pure functions with tests over the graph's properties.
 * This class does three things and nothing else:
 *
 *   1. translates domain events into machine events,
 *   2. keeps the current state,
 *   3. announces it, so every view can derive itself from it.
 *
 * It deliberately does NOT tell views to show themselves. Under Moore an output
 * is a function of the state alone, so a view that wants to be on screen reads
 * the state — see `viewForState`. The design this replaces commanded the views
 * on the edges (`PLAYER:SHOW`, `LOADING:SHOW`, `ERROR:SHOW` each meaning "and
 * everyone else hide"), which is how four flows came to show the loading view
 * with no transition at all: the state said PLAYING, the screen said loading,
 * and nothing could detect the disagreement because the state asserted nothing
 * about the screen.
 */
class TorrentTV {
  static MESSAGES = {
    errorTitle: "Error",
    playbackFailed: (message) =>
      typeof message === "string" && message.trim().length > 0 ? message : "Playback failed.",
    playbackPreparing: "Preparing playback..."
  };

  #state = INITIAL_STATE;

  /**
   * Number of video files in the currently loaded torrent. Extended state, not a
   * state: it changes which buttons the error screen offers and nothing else.
   *
   * @type {number}
   */
  #videoCount = 0;

  /**
   * Whether the viewer wants the picture to move — mirrored from the media
   * element by the player, never decided here. Consulted by the guard on
   * `STREAM_READY`, so a rebuild that finishes while the viewer is paused lands
   * in PAUSED instead of starting playback at them.
   *
   * @type {boolean}
   */
  #viewerWantsPlayback = true;

  /**
   * Feed the machine an event and apply the answer.
   *
   * Three outcomes, all of them normal, none of them an exception. The machine
   * this replaces threw on a transition it did not allow, from inside a DOM
   * event listener, so the rest of the handler was abandoned and its flags went
   * on describing a state the app had left — its safety check was the failure.
   *
   * @param {string} event - One of `APP_EVENT`.
   * @param {object} [context] - Extended state for guards.
   * @returns {boolean} Whether the state changed.
   */
  #send(event, context = {}) {
    const target = nextState(this.#state, event, {
      viewerWantsPlayback: this.#viewerWantsPlayback,
      ...context
    });
    if (target === null) {
      // The event means nothing here. Worth a line: it is either a stale event
      // from an abandoned attempt or a wiring mistake, and both are things one
      // wants to see rather than guess at.
      this.#logEvt(`ignored ${event} in ${this.#state}`);
      return false;
    }
    if (target === this.#state) {
      // An edge that leads back to where we already are — today only a rebuild
      // asked for while one is already running. The state does not change, but
      // the outputs must still be applied: a view that hid itself imperatively
      // (Cancel, the playlist stepping aside) is otherwise never told to come
      // back, and the next episode built behind a blank player with no sign of
      // anything happening.
      this.#logEvt(`${this.#state} re-entered on ${event}`);
      document.dispatchEvent(
        new CustomEvent(APP_EVENTS.STATE_CHANGED, { detail: { state: target } })
      );
      return false;
    }
    const from = this.#state;
    this.#state = target;
    this.#logEvt(`${from} -> ${target} on ${event}`);
    document.dispatchEvent(
      new CustomEvent(APP_EVENTS.STATE_CHANGED, { detail: { state: target } })
    );
    return true;
  }

  /**
   * Open a source. When one is already open this is a REPLACEMENT, and it is
   * expressed as what it is — the old source closes, the new one opens — rather
   * than as a transition that re-enters the state it is already in. The machine
   * has no self-loops on purpose: entering OPENING starts building a stream, and
   * an event that silently re-ran that entry work is how encodes nobody asked
   * for used to start.
   *
   * @returns {void}
   */
  #openSource() {
    if (isWithin(this.#state, APP_SUPERSTATE.OPEN)) {
      this.#send(APP_EVENT.CLOSED);
    }
    this.#send(APP_EVENT.SOURCE_OPENED);
  }

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
    this.#videoCount = Array.isArray(mediaFiles?.video) ? mediaFiles.video.length : 0;
    this.#openSource();
    this.#setLoadingContent(file.name, TorrentTV.MESSAGES.playbackPreparing);

    document.dispatchEvent(
      new CustomEvent(LOADING_EVENTS.PROCESS_PLAYBACK, {
        detail: {
          file, torrentBytes, meta, mediaFiles,
          currentTime: payload?.currentTime ?? null,
          fileIndex: payload?.fileIndex ?? null
        }
      })
    );
  };

  #logEvt(message) {
    console.debug(`[evt] ${new Date().toISOString().slice(11, 23)} ${message}`);
  }

  /** @param {CustomEvent} event */
  #onMagnetReady = (event) => {
    const magnetUri = event instanceof CustomEvent ? event.detail?.magnetUri : "";
    const currentTime = event instanceof CustomEvent ? (event.detail?.currentTime ?? null) : null;
    const fileIndex = event instanceof CustomEvent ? (event.detail?.fileIndex ?? null) : null;
    if (typeof magnetUri !== "string" || magnetUri.length === 0) {
      return;
    }
    // File count is unknown until the swarm metadata arrives; the
    // SET_MEDIA_FILES listener updates it then.
    this.#videoCount = 0;
    this.#openSource();
    this.#setLoadingContent("Magnet link", TorrentTV.MESSAGES.playbackPreparing);
    document.dispatchEvent(
      new CustomEvent(LOADING_EVENTS.PROCESS_MAGNET, {
        detail: { magnetUri, currentTime, fileIndex }
      })
    );
  };

  /** Keep the video-file count current (drives the error screen's buttons). */
  #onSetMediaFiles = (event) => {
    const detail = event instanceof CustomEvent ? event.detail : null;
    this.#videoCount = Array.isArray(detail?.video) ? detail.video.length : 0;
  };

  /**
   * The pipeline is rebuilding the stream — a quality or audio switch, a
   * reconnect, a manual Retry. Each of these used to re-show the loading view
   * WITHOUT any transition, so the machine said PLAYING while the screen said
   * loading. They now say what they are.
   */
  #onLoadingShow = () => {
    this.#send(APP_EVENT.REBUILD_REQUIRED);
  };

  /** @param {CustomEvent} event */
  #onPlaybackReady = (event) => {
    const detail = event instanceof CustomEvent ? event.detail : null;
    if (typeof detail?.viewerWantsPlayback === "boolean") {
      this.#viewerWantsPlayback = detail.viewerWantsPlayback;
    }
    this.#send(APP_EVENT.STREAM_READY);
  };

  /** @param {CustomEvent} event */
  #onPlaybackFailed = (event) => {
    const payload = event instanceof CustomEvent ? event.detail : null;
    const description =
      typeof payload?.description === "string" ? payload.description : TorrentTV.MESSAGES.playbackFailed("");
    const canRetry = payload?.canRetry === true;
    if (!this.#send(APP_EVENT.FATAL_FAILURE)) {
      // A failure with no open source is a late answer from an attempt that was
      // abandoned. It used to be shown, dragging the viewer from the picker to
      // an error screen for something they had already walked away from.
      return;
    }
    this.#showError(TorrentTV.MESSAGES.playbackFailed(description), { canRetry });
  };

  #onRetryPlayback = () => {
    this.#openSource();
  };

  #onBackToPlaylist = () => {
    // Returning to the CHOICE, which is not the same as opening a file. Sent as
    // SOURCE_OPENED it claimed a build nobody had started, and the modal waiting
    // view came up over the episode list carrying the failed file's name.
    // Meaningful only from the error screen; while a source is already playing
    // the panel opening is a view matter and not a transition, and the machine
    // ignores it by having no such edge.
    this.#send(APP_EVENT.FILE_CHOICE_REQUESTED);
  };

  #onAppReset = () => {
    this.#videoCount = 0;
    this.#viewerWantsPlayback = true;
    this.#send(APP_EVENT.CLOSED);
  };

  /**
   * Anything that is not a domain event feeds the machine through here:
   * the picture blocking and unblocking, the viewer pausing and resuming.
   *
   * @param {CustomEvent} event
   */
  #onSignal = (event) => {
    const detail = event instanceof CustomEvent ? event.detail : null;
    const machineEvent = typeof detail?.event === "string" ? detail.event : "";
    if (machineEvent.length === 0) {
      return;
    }
    const context = detail?.context && typeof detail.context === "object" ? detail.context : {};
    // Committed only if the machine ACCEPTS the event. An event it refuses did
    // not happen as far as the application is concerned, and letting a refused
    // one move the extended state is the same fault as the old machine's flags
    // describing a state it had already left.
    if (this.#send(machineEvent, context) && typeof context.viewerWantsPlayback === "boolean") {
      this.#viewerWantsPlayback = context.viewerWantsPlayback;
    }
  };

  constructor () {
    this.#setupEventHandlers();
    // Announce the initial state so every view can derive itself from it rather
    // than assuming what it should look like before the first transition.
    document.dispatchEvent(
      new CustomEvent(APP_EVENTS.STATE_CHANGED, { detail: { state: this.#state } })
    );
  }

  #setupEventHandlers = () => {
    document.addEventListener(TORRENT_EVENTS.FILE_DETAILS_READY, this.#onTorrentFileDetailsReady);
    document.addEventListener(TORRENT_EVENTS.MAGNET_READY, this.#onMagnetReady);
    document.addEventListener(PLAYER_EVENTS.SET_MEDIA_FILES, this.#onSetMediaFiles);
    document.addEventListener(LOADING_EVENTS.SHOW, this.#onLoadingShow);
    document.addEventListener(LOADING_EVENTS.PLAYBACK_READY, this.#onPlaybackReady);
    document.addEventListener(LOADING_EVENTS.PLAYBACK_FAILED, this.#onPlaybackFailed);
    document.addEventListener(APP_EVENTS.RETRY_PLAYBACK, this.#onRetryPlayback);
    document.addEventListener(APP_EVENTS.RESET_TO_PICKER, this.#onAppReset);
    document.addEventListener(APP_EVENTS.BACK_TO_PLAYLIST, this.#onBackToPlaylist);
    document.addEventListener(APP_EVENTS.SIGNAL, this.#onSignal);
  };

  /**
   * Set what the waiting view says. Content only — whether it is on screen
   * follows from the state.
   *
   * @param {string} fileName
   * @param {string} status
   */
  #setLoadingContent(fileName, status) {
    document.dispatchEvent(
      new CustomEvent(LOADING_EVENTS.SET_FILE_NAME, { detail: { value: fileName } })
    );
    document.dispatchEvent(
      new CustomEvent(LOADING_EVENTS.SET_STATUS, { detail: { value: status } })
    );
  }

  /**
   * Fill the error view. Does NOT transition — the caller already did, and a
   * method that both moves the machine and paints a screen is how one edge came
   * to be written in two places for a single event.
   *
   * @param {string} description
   * @param {{ canRetry?: boolean }} [options]
   */
  #showError(description, { canRetry = false } = {}) {
    document.dispatchEvent(
      new CustomEvent(ERROR_EVENTS.SHOW, {
        detail: {
          title: TorrentTV.MESSAGES.errorTitle,
          description,
          // Show "Back to episodes" only when the torrent has multiple video
          // files, so the viewer can pick a different one without re-uploading.
          canGoBackToPlaylist: this.#videoCount > 1,
          // Recoverable error (connection lost mid-playback) — offer Retry.
          canRetry
        }
      })
    );
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
