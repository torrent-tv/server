/**
 * @file The address bar as the application's state, and the rules for moving
 * between states.
 *
 * Three states are addressable, and they are the three a person actually
 * arrives at:
 *
 *   /                                        the torrent picker
 *   ?magnet=…                                that torrent's file list
 *   ?magnet=…&fileIndex=…[&currentTime=…]    playing one file
 *
 * The error screen is deliberately not among them: it is a transient condition,
 * not somewhere anyone bookmarks or navigates to.
 *
 * A magnet cannot be a path segment — it is long and full of characters a path
 * cannot carry — so these are query parameters, the same ones the share link
 * builds and the loader already parses.
 *
 * The decisions live here, as pure functions, because their difficulty is
 * combinatorial rather than technical: which of push/replace, and which of four
 * ways to enter a state, depends on where the viewer already is. That is a
 * matrix, and a matrix should be tested rather than reasoned about once.
 */

/**
 * @typedef {object} UrlState
 * @property {string} magnet - Empty when none.
 * @property {number} fileIndex - -1 when none.
 * @property {number} currentTime - Whole seconds; 0 when none.
 */

/**
 * Read the state a query string names.
 *
 * @param {string} search - `location.search`, with or without the leading `?`.
 * @returns {UrlState}
 */
export function readUrlState(search) {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  const magnet = (params.get("magnet") ?? "").trim();
  const fileIndexRaw = Number.parseInt(params.get("fileIndex") ?? "", 10);
  const currentTimeRaw = Number.parseInt(params.get("currentTime") ?? "", 10);
  return {
    magnet,
    fileIndex: Number.isFinite(fileIndexRaw) && fileIndexRaw >= 0 ? fileIndexRaw : -1,
    currentTime: Number.isFinite(currentTimeRaw) && currentTimeRaw > 0 ? currentTimeRaw : 0
  };
}

/**
 * The query string for a state. Parameters are written in a fixed order so two
 * addresses for the same state compare equal as strings.
 *
 * @param {UrlState} state
 * @returns {string} Including the leading `?`, or "" for the picker.
 */
export function buildUrlSearch(state) {
  if (!state.magnet) {
    return "";
  }
  let search = `?magnet=${encodeURIComponent(state.magnet)}`;
  if (state.fileIndex >= 0) {
    search += `&fileIndex=${state.fileIndex}`;
  }
  if (state.currentTime > 0) {
    search += `&currentTime=${Math.floor(state.currentTime)}`;
  }
  return search;
}

/**
 * Whether moving to this state should add a history entry or overwrite the one
 * in the address bar.
 *
 * The rule is the whole design in one line: an entry per THING WATCHED, never
 * per moment of watching. A different torrent or a different file is a new
 * thing — push, so Back returns to the previous episode or page. The same file
 * a few seconds further on is the same thing — replace, so a two-hour film
 * leaves exactly one entry behind instead of thousands.
 *
 * It also makes the Back button safe by construction: after the browser
 * restores an entry, the address already names that state, so writing it again
 * replaces rather than pushes. A handler for Back cannot accidentally bury the
 * history it is walking.
 *
 * @param {UrlState} current - What the address bar says now.
 * @param {UrlState} next - What it should say.
 * @returns {"push" | "replace" | "none"}
 */
export function decideHistoryWrite(current, next) {
  if (
    current.magnet === next.magnet &&
    current.fileIndex === next.fileIndex &&
    current.currentTime === next.currentTime
  ) {
    // Nothing to say. Writing anyway is harmless on a torrent — the position
    // moves, so this is rare — but on the empty address it would fire on every
    // pass and, worse, invite a history entry for arriving where we already
    // are.
    return "none";
  }
  if (current.magnet !== next.magnet) {
    return "push";
  }
  if (current.fileIndex !== next.fileIndex) {
    return "push";
  }
  return "replace";
}

/**
 * Whether leaving `fromIndex` for `toIndex` means "finished with it".
 *
 * Watching to the end and going on to the next episode, and skipping the
 * credits to go on to the next episode, are the same intention — so the
 * position in the file being left is only worth keeping when the viewer jumps
 * somewhere ELSE. Reading the intention from the destination avoids having to
 * ask how near the end counts as the end, which cannot be answered: credits run
 * for different lengths in every release, and most people never watch them.
 *
 * @param {number} fromIndex
 * @param {number} toIndex
 * @param {number[]} videoIndexes - Playable file indexes, in playlist order.
 * @returns {boolean}
 */
export function isAdvanceToNext(fromIndex, toIndex, videoIndexes) {
  const from = videoIndexes.indexOf(fromIndex);
  const to = videoIndexes.indexOf(toIndex);
  if (from < 0 || to < 0) {
    return false;
  }
  return to === from + 1;
}

/**
 * What has to happen to show the state the address now names.
 *
 * Called when the viewer presses Back or Forward, where the browser hands over
 * an address and nothing else — whatever the application held in memory belongs
 * to the state being left. Each answer is the cheapest one that is correct: a
 * different torrent has to be loaded from scratch, another file of the SAME
 * torrent only has to be opened, and the same file only has to be seeked.
 *
 * @param {UrlState} current - What is on screen.
 * @param {UrlState} target - What the address now names.
 * @returns {{ action: "none" | "picker" | "playlist" | "load-source" | "open-file" | "seek", fileIndex: number, currentTime: number }}
 */
export function decideNavigation(current, target) {
  const answer = (action) => ({ action, fileIndex: target.fileIndex, currentTime: target.currentTime });

  if (!target.magnet) {
    return current.magnet ? answer("picker") : answer("none");
  }
  if (target.magnet !== current.magnet) {
    // Another torrent entirely — it may not even be in memory any more.
    return answer("load-source");
  }
  if (target.fileIndex < 0) {
    // The torrent's own entry: its file list, with nothing playing.
    return current.fileIndex < 0 ? answer("none") : answer("playlist");
  }
  if (target.fileIndex !== current.fileIndex) {
    return answer("open-file");
  }
  // Same file. Only a position can differ, and only meaningfully so: a Back
  // that lands within a second of where the viewer already is should not yank
  // the picture.
  if (Math.abs(target.currentTime - current.currentTime) <= 1) {
    return answer("none");
  }
  return answer("seek");
}

/**
 * The position the address bar offers for a file that is about to be opened.
 *
 * The address carries one position, and it belongs to the file it was written
 * for. While a new file is being opened the address still describes the
 * previous one — it is rewritten from the active file index, which does not
 * become the new file until the load finishes — so reading the position
 * regardless starts an episode wherever the last one had got to. Reported from
 * the field 2026-08-11, and the further into an episode the viewer was, the
 * further into the next one it began.
 *
 * @param {ReturnType<typeof readUrlState>} state - What the address says now.
 * @param {number} fileIndex - The file being opened.
 * @returns {number} Seconds to resume at; 0 when the address has nothing to
 *   say about THIS file.
 */
export function resumePositionFor(state, fileIndex) {
  if (!state || !Number.isInteger(fileIndex) || fileIndex < 0) {
    return 0;
  }
  if (state.fileIndex !== fileIndex) {
    return 0;
  }
  return state.currentTime > 0 ? state.currentTime : 0;
}

/**
 * The position worth writing into the address, given what the media element
 * says and what the address already holds.
 *
 * A media element that has been torn down reports `currentTime === 0` and
 * `readyState === 0`, and it reports them through the same events that record a
 * real position — `timeupdate`, `pause`, `pagehide`. Measured 2026-08-14: an
 * append failure ended the MediaSource, the element reset to zero, one of those
 * events fired, the zero was written, and `buildUrlSearch` omits a zero
 * position entirely — so the parameter vanished and the viewer's refresh
 * started the film from the beginning. The address was otherwise intact; only
 * the position was gone.
 *
 * The rule: a zero from an element with nothing loaded is not evidence about
 * where the viewer was. Neither is a zero from an element that has never
 * played, while the address already names a position — that is the state
 * between opening a link and the seek that honours it.
 *
 * @param {{ readyState: number, currentTime: number }} element - What the media
 *   element reports now.
 * @param {number} recorded - The position already in the address, in seconds.
 * @returns {number} Seconds to write.
 */
export function positionToRecord(element, recorded) {
  const known = Number.isFinite(recorded) && recorded > 0 ? Math.floor(recorded) : 0;
  if (!element || !Number.isFinite(element.currentTime) || !Number.isFinite(element.readyState)) {
    return known;
  }
  const position = Math.floor(element.currentTime);
  if (position > 0) {
    return position;
  }
  // Zero, from here on. Only an element that is actually holding media may say
  // the viewer is at the beginning; anything else keeps what the address knows.
  return element.readyState > 0 ? 0 : known;
}
