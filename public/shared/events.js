/** Torrent domain events. */
export const TORRENT_EVENTS = {
  FILE_DETAILS_READY: "TORRENT:FILE_DETAILS_READY",
  MAGNET_READY: "TORRENT:MAGNET_READY"
};

/** Loading view events. */
/**
 * Facts about a wait, for the overlay that shows it.
 *
 * Deliberately NOT "show this text": the overlay is told what was measured and
 * which step began, and decides for itself what that adds up to on screen. The
 * shape it replaces — handing it finished text — produced the same defect three
 * times, a caller feeding back what the overlay had just rendered until the
 * line grew off the screen.
 */
export const WAITING_EVENTS = {
  /** Detail: a partial `WaitingMeasurements`; absent fields are left alone. */
  MEASURED: "WAITING:MEASURED",
  /** Detail: `{ value }` — the name of the step the pipeline has reached. */
  STEP: "WAITING:STEP"
};

export const LOADING_EVENTS = {
  SHOW: "LOADING:SHOW",
  SET_FILE_NAME: "LOADING:SET_FILE_NAME",
  SET_STATUS: "LOADING:SET_STATUS",
  SET_PROGRESS: "LOADING:SET_PROGRESS",
  PROCESS_PLAYBACK: "LOADING:PROCESS_PLAYBACK",
  PROCESS_MAGNET: "LOADING:PROCESS_MAGNET",
  PLAYBACK_READY: "LOADING:PLAYBACK_READY",
  PLAYBACK_FAILED: "LOADING:PLAYBACK_FAILED"
};

/** Error view events. */
export const ERROR_EVENTS = {
  SHOW: "ERROR:SHOW"
};

/** Player view events. */
export const PLAYER_EVENTS = {
  /**
   * `{ bufferedAhead, fillRate }` — what the element itself holds, measured by
   * the component that owns it. Nobody else may read `video.buffered`: one
   * owner per fact.
   */
  BUFFER: "PLAYER:BUFFER",
  SHOW: "PLAYER:SHOW",
  SET_MEDIA_FILES: "PLAYER:SET_MEDIA_FILES",
  SET_ACTIVE_MEDIA_FILE: "PLAYER:SET_ACTIVE_MEDIA_FILE",
  SELECT_MEDIA_FILE: "PLAYER:SELECT_MEDIA_FILE",
  READY: "PLAYER:READY",
  REQUEST_READY: "PLAYER:REQUEST_READY",
  OPEN_PLAYLIST: "PLAYER:OPEN_PLAYLIST",
  CLOSE_PLAYLIST: "PLAYER:CLOSE_PLAYLIST",
  FOCUS_PLAYLIST_TOGGLE: "PLAYER:FOCUS_PLAYLIST_TOGGLE",
  SET_AUDIO_TRACKS: "PLAYER:SET_AUDIO_TRACKS",
  SELECT_AUDIO_TRACK: "PLAYER:SELECT_AUDIO_TRACK",
  SET_QUALITY_OPTIONS: "PLAYER:SET_QUALITY_OPTIONS",
  SELECT_QUALITY: "PLAYER:SELECT_QUALITY",
  SET_BUFFERING: "PLAYER:SET_BUFFERING",
  SET_SHARE_LINK: "PLAYER:SET_SHARE_LINK",
};

/** Application-wide events. */
export const APP_EVENTS = {
  RESET_TO_PICKER: "APP:RESET_TO_PICKER",
  BACK_TO_PLAYLIST: "APP:BACK_TO_PLAYLIST",
  RETRY_PLAYBACK: "APP:RETRY_PLAYBACK",
  /**
   * The application's state machine moved. Carries `{ state }` — one of
   * `TorrentTV.STATE`. Components that must behave differently depending on
   * where the app is (the playlist, when nothing is playing) listen for this
   * rather than each inferring it from the events they happen to see.
   */
  STATE_CHANGED: "APP:STATE_CHANGED",
  /**
   * The single way anything feeds the state machine something it did not
   * already learn from a domain event. Carries
   * `{ event, context }` — `event` one of `APP_EVENT` in
   * `domain/app-state.js`, `context` the extended state a guard may need.
   *
   * One channel rather than one DOM event per machine event: the machine has a
   * single entry point, so "who can move the app" is answerable by grepping for
   * one name.
   */
  SIGNAL: "APP:SIGNAL"
};

/**
 * Feed the state machine an event.
 *
 * @param {string} event - One of `APP_EVENT` in `domain/app-state.js`.
 * @param {object} [context] - Extended state for guards (`viewerWantsPlayback`).
 * @returns {void}
 */
export function signalApp(event, context = {}) {
  document.dispatchEvent(
    new CustomEvent(APP_EVENTS.SIGNAL, { detail: { event, context } })
  );
}

/**
 * The proxy no longer has the transcode session the player is using — it was
 * disposed after the browser was away, or the proxy restarted. Detected by the
 * keep-alive ping getting a 404. The player rebuilds a session for the same
 * file and continues from where it was.
 */
export const SESSION_EVENTS = {
  GONE: "session:gone",
  /**
   * A progress report from the keep-alive poll, which runs for as long as a
   * session is held. It is the only reading of the proxy's state during steady
   * playback — the buffering poll runs only while the picture is stopped.
   */
  PROGRESS: "session:progress"
};

/**
 * Raw answers from the proxy, published as they arrive. Facts, not decisions:
 * whoever needs them interprets them itself. This is what lets the waiting
 * overlay work its own figures out instead of being handed conclusions.
 */
export const PROXY_EVENTS = {
  /** `{ downloadStats, transcodeProgress }` — the two poll answers. */
  MEASURED: "PROXY:MEASURED"
};
