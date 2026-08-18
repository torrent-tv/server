/**
 * @file A fragment fetched again and again while the buffer stands still.
 *
 * Measured 2026-08-18: after a seek whose target segment answered 503, the
 * player fetched the SAME two audio segments — `a/0/segment-00103.mp4` and
 * `a/0/segment-00104.mp4` — **737 and 736 times in 149 seconds**, about ten
 * requests a second at 337 KB each, roughly half a gigabyte of the same bytes,
 * while the picture stood at `t=1061.0s readyState=1` and never moved. The same
 * shape was recorded on 2026-08-02, when one segment was repeated 1908 times.
 * Nothing anywhere counts these, so nothing ever stops.
 *
 * What makes a repeat FRUITLESS is measurable and needs no chosen number, and
 * the first version of this file got it wrong. It asked only whether the end of
 * the buffer had moved — and killed a HEALTHY session 40 minutes after it
 * shipped (2026-08-18 20:37:01): changing the audio language re-appends the
 * replacement track into a span the picture already covers, `video.buffered` is
 * the INTERSECTION of the two source buffers, so its end does not move and need
 * not. Three appends inside 79 ms were declared a loop while the picture was
 * playing normally.
 *
 * The playhead is what tells them apart. In the loop this file exists for, the
 * picture stood at `t=1061.0s` for 149 seconds; in the audio change it advanced
 * 1369.80 → 1369.84 → 1369.88 across the very appends that were flagged. So a
 * repeat is fruitless only when the player is trying to play and NEITHER the
 * end of the buffer NOR the playhead moved since the last append of the same
 * fragment. A paused player is excluded for the same reason: its playhead is
 * standing still because the viewer stopped it, which is not a defect.
 *
 * One such repeat is reported and tolerated, because a fragment is legitimately
 * re-appended after the buffer is flushed and a flush may be missed (a level
 * switch, a recovery, a source reset all cause one). Two consecutive fruitless
 * repeats of the same fragment cannot be explained that way, and that is when
 * the loop is declared. The caller resets the count on every flush it sees, so
 * the tolerance covers only the flushes it did NOT see.
 */

/**
 * @typedef {object} RepeatVerdict
 * @property {number} fruitless - Consecutive appends of this fragment that did
 *   not move the end of the buffer.
 * @property {boolean} looping - Whether this fragment is now established as
 *   being fetched without effect.
 * @property {number} bufferedEnd - The reading this verdict was made against.
 */

/**
 * Watch fragments as they are appended, and say when one is being appended for
 * nothing.
 *
 * @returns {{ note: (fragment: { key: string, bufferedEnd: number }) => RepeatVerdict, forget: () => void }}
 */
export function createRepeatGuard() {
  /** @type {Map<string, { bufferedEnd: number, playhead: number, fruitless: number }>} */
  let seen = new Map();

  return {
    /**
     * Record one append.
     *
     * @param {{ key: string, bufferedEnd: number, playhead: number, playing: boolean }} fragment -
     *   `key` identifies the fragment (its stream, level and sequence number);
     *   `bufferedEnd` is how far the buffer reaches now; `playhead` is where the
     *   picture stands; `playing` is false when the viewer has paused, and then
     *   a motionless playhead says nothing.
     * @returns {RepeatVerdict}
     */
    note({ key, bufferedEnd, playhead, playing }) {
      const end = Number.isFinite(bufferedEnd) ? bufferedEnd : 0;
      const at = Number.isFinite(playhead) ? playhead : 0;
      const known = seen.get(key);
      if (!known) {
        seen.set(key, { bufferedEnd: end, playhead: at, fruitless: 0 });
        return { fruitless: 0, looping: false, bufferedEnd: end };
      }
      // Either measurement moving means the append was worth making: the buffer
      // grew, or the picture is still running on what is already held. The
      // count starts over, because what matters is CONSECUTIVE appends that
      // achieved nothing.
      const moved = end > known.bufferedEnd || at > known.playhead;
      if (moved || playing !== true) {
        seen.set(key, { bufferedEnd: end, playhead: at, fruitless: 0 });
        return { fruitless: 0, looping: false, bufferedEnd: end };
      }
      const fruitless = known.fruitless + 1;
      seen.set(key, { bufferedEnd: known.bufferedEnd, playhead: known.playhead, fruitless });
      return { fruitless, looping: fruitless >= 2, bufferedEnd: end };
    },

    /**
     * Forget everything — the buffer was flushed, so an append that repeats a
     * fragment is expected and says nothing about a loop.
     *
     * @returns {void}
     */
    forget() {
      seen = new Map();
    }
  };
}

/**
 * The name a fragment is counted under.
 *
 * The stream matters as much as the number: a video segment 103 and an audio
 * segment 103 are different fragments, and on the session that produced this
 * file it was the AUDIO rendition that looped while the picture stood still.
 *
 * @param {{ type?: string, level?: number, sn?: number | string }} frag
 * @returns {string}
 */
export function fragmentKey(frag) {
  const stream = typeof frag?.type === "string" && frag.type !== "" ? frag.type : "main";
  const level = Number.isFinite(frag?.level) ? frag.level : -1;
  const sn = frag?.sn ?? "?";
  return `${stream}:${level}:${sn}`;
}
