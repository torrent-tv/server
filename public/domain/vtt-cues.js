/**
 * @file Turning WebVTT text into cues the player can be given one at a time.
 *
 * A `<track src="blob:…">` can only be replaced, never added to, so a track
 * that grows as the film downloads was being fetched whole every few seconds —
 * measured 2026-08-19, up to 76 KB a time for a track the browser already held
 * almost all of. Parsing the text here means the proxy can send only what is
 * new and the player keeps the cues it already has.
 *
 * Only what our own proxy emits is understood, which is the plain form of the
 * format: an optional identifier line, a timing line, then the text. Cue
 * settings after the timing are kept out — they position text on screen, we
 * never write them, and guessing at them would put captions in odd places.
 */

/** `HH:MM:SS.mmm` or `MM:SS.mmm`, as WebVTT allows both. */
const TIMING = /^(?:(\d+):)?(\d{1,2}):(\d{2})\.(\d{1,3})\s*-->\s*(?:(\d+):)?(\d{1,2}):(\d{2})\.(\d{1,3})/;

/**
 * Seconds from the parts of one WebVTT timestamp.
 *
 * @param {string | undefined} hours
 * @param {string} minutes
 * @param {string} seconds
 * @param {string} milliseconds
 * @returns {number}
 */
function toSeconds(hours, minutes, seconds, milliseconds) {
  return (Number(hours ?? 0) * 3600) +
    (Number(minutes) * 60) +
    Number(seconds) +
    (Number(milliseconds.padEnd(3, "0")) / 1000);
}

/**
 * @typedef {object} ParsedCue
 * @property {number} startSeconds
 * @property {number} endSeconds
 * @property {string} text
 */

/**
 * Every cue in a WebVTT document, in the order it was written.
 *
 * @param {string} vtt
 * @returns {ParsedCue[]}
 */
export function parseVttCues(vtt) {
  if (typeof vtt !== "string" || !vtt.startsWith("WEBVTT")) {
    return [];
  }
  /** @type {ParsedCue[]} */
  const cues = [];
  // Blocks are separated by a blank line; \r\n and \n both appear in the wild.
  for (const block of vtt.replace(/\r\n/g, "\n").split(/\n{2,}/)) {
    const lines = block.split("\n").filter((line) => line.trim() !== "");
    if (lines.length === 0) {
      continue;
    }
    // The timing line is the first that looks like one: an identifier may sit
    // above it, and the header block has none at all.
    const timingAt = lines.findIndex((line) => TIMING.test(line));
    if (timingAt === -1) {
      continue;
    }
    const match = TIMING.exec(lines[timingAt]);
    const text = lines.slice(timingAt + 1).join("\n").trim();
    if (text === "") {
      continue;
    }
    const startSeconds = toSeconds(match[1], match[2], match[3], match[4]);
    const endSeconds = toSeconds(match[5], match[6], match[7], match[8]);
    // A cue that ends before it starts cannot be shown, and the browser throws
    // on it rather than ignoring it.
    if (!(endSeconds > startSeconds)) {
      continue;
    }
    cues.push({ startSeconds, endSeconds, text });
  }
  return cues;
}

/**
 * What identifies a cue: when it starts, when it ends, and what it says. Two
 * deliveries of the same line are the same cue whichever route they came by.
 *
 * @param {ParsedCue} cue
 * @returns {string}
 */
function keyOf(cue) {
  return `${cue.startSeconds}|${cue.endSeconds}|${cue.text}`;
}

/**
 * Add the cues a track does not have yet, and say where it now ends.
 *
 * A cue is recognised by what it IS, through `seen`, and not by being later
 * than the last one added. Two reasons, both met in the field:
 *
 * - the same cue really can arrive twice — a re-subscription after a reconnect
 *   asks for everything the page missed, and a push emitted at that moment
 *   carries some of it as well. Compared against a cursor, both copies are
 *   added and the viewer sees a doubled line;
 * - two cues can legitimately start at the same instant (an ASS sign over a
 *   line of dialogue), and a rule that only accepts a LATER start threw the
 *   second one away.
 *
 * `track.cues` cannot serve as the record: it reads null while the track's mode
 * is `disabled`, which is exactly when cues arrive for a track the viewer has
 * not turned on yet.
 *
 * @param {TextTrack} track
 * @param {ParsedCue[]} cues
 * @param {Set<string>} seen - Keys of the cues this track already holds; added
 *   to as they are appended, so the caller keeps one per track.
 * @returns {{ added: number, knownUntilSeconds: number }}
 */
export function appendCues(track, cues, seen) {
  let until = -1;
  let added = 0;
  for (const cue of cues) {
    const key = keyOf(cue);
    if (seen.has(key)) {
      continue;
    }
    try {
      track.addCue(new VTTCue(cue.startSeconds, cue.endSeconds, cue.text));
      seen.add(key);
      added += 1;
      until = Math.max(until, cue.startSeconds);
    } catch (error) {
      // silent-ok: a cue the player refuses is one line of dialogue, and the
      // rest of the track is worth more than reporting it; the caller is given
      // the count of what was added, which is where a shortfall shows.
      void error;
    }
  }
  return { added, knownUntilSeconds: until };
}
