/**
 * @file What a subtitle track can draw at the position being played.
 *
 * Pure, so it can be tested without a browser: the caller passes plain cues and
 * a playhead, and gets back the figures the log prints and the verdict that
 * decides whether the reading repeats. Extracted from `loading.js` for exactly
 * that reason — the rule went wrong once already and nothing could catch it.
 */

/**
 * @typedef {object} CueLike
 * @property {number} startTime
 * @property {number} endTime
 */

/**
 * @typedef {object} Coverage
 * @property {number} count - How many cues the track holds.
 * @property {number | null} first - The earliest start time held.
 * @property {number | null} last - The latest END time held, which is not the
 *   last cue's: the list is ordered by START, and a sign held over dialogue can
 *   begin earlier and finish later than the entry after it.
 * @property {number} covering - How many held cues cover the playhead.
 * @property {number | null} nextAhead - The nearest start time after the
 *   playhead, or null when the track holds nothing ahead.
 * @property {boolean} unsupplied - Whether the track has nothing to draw where
 *   the viewer is: nothing covering the playhead AND the playhead outside the
 *   stretch the track holds.
 * @property {string} signature - What the reading SAYS, with the playhead left
 *   out. Two consecutive readings with the same signature carry the same
 *   information, and the second is not worth printing.
 */

/**
 * Read one track against one playhead.
 *
 * The verdict is not "nothing is on screen": between two lines of dialogue
 * there is nothing on screen and nothing is wrong. It is not "nothing lies
 * ahead" either — that rule hid the failure it was written for, where the track
 * held cues from 3356 s while the viewer sat at 3192 s and so always had
 * something "ahead" while nothing could be drawn for 165 s in either direction.
 * It is the playhead being OUTSIDE the stretch the track holds: inside it, a
 * blank screen is the film's own pause.
 *
 * @param {ArrayLike<CueLike> | null | undefined} cues - `track.cues`, which is
 *   null while the mode is `disabled`.
 * @param {number} playheadSeconds
 * @returns {Coverage}
 */
export function readCoverage(cues, playheadSeconds) {
  const count = cues ? cues.length : 0;
  const now = Number.isFinite(playheadSeconds) ? playheadSeconds : 0;
  let first = null;
  let last = null;
  let covering = 0;
  let nextAhead = null;
  for (let index = 0; index < count; index += 1) {
    const cue = cues[index];
    if (first === null || cue.startTime < first) {
      first = cue.startTime;
    }
    if (last === null || cue.endTime > last) {
      last = cue.endTime;
    }
    if (cue.startTime <= now && now < cue.endTime) {
      covering += 1;
    } else if (cue.startTime > now && (nextAhead === null || cue.startTime < nextAhead)) {
      nextAhead = cue.startTime;
    }
  }
  const unsupplied = covering === 0 && (count === 0 || now < first || now > last);
  const span = count > 0 ? `${first.toFixed(1)}-${last.toFixed(1)}s` : "none";
  return {
    count,
    first,
    last,
    covering,
    nextAhead,
    unsupplied,
    // The playhead moves every tick and is deliberately absent: what makes a
    // second reading worth a line is a change in what the track HOLDS, or in
    // the verdict, not in the clock.
    signature: `${count}|${span}|${covering}|${unsupplied}`
  };
}

/**
 * The line the log prints for one track.
 *
 * @param {string} cause
 * @param {string} label
 * @param {Coverage} coverage
 * @param {number} playheadSeconds
 * @param {number | null} unsuppliedForSeconds
 * @returns {string}
 */
export function describeCoverage(cause, label, coverage, playheadSeconds, unsuppliedForSeconds) {
  const span = coverage.count > 0
    ? `${coverage.first.toFixed(1)}-${coverage.last.toFixed(1)}s`
    : "none";
  const next = coverage.nextAhead === null
    ? "none"
    : `${(coverage.nextAhead - playheadSeconds).toFixed(1)}s ahead`;
  return `[torrent-tv][subtitles] coverage (${cause}) "${label}": ` +
    `cues=${coverage.count} span=${span} playhead=${playheadSeconds.toFixed(1)}s ` +
    `covering=${coverage.covering} next=${next}` +
    (unsuppliedForSeconds === null ? "" : ` unsuppliedFor=${unsuppliedForSeconds.toFixed(1)}s`);
}
