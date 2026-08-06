/** Torrent domain events. */
export const TORRENT_EVENTS = {
  FILE_DETAILS_READY: "TORRENT:FILE_DETAILS_READY",
  MAGNET_READY: "TORRENT:MAGNET_READY"
};

/** Loading view events. */
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
  STATE_CHANGED: "APP:STATE_CHANGED"
};

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
