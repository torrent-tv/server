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
 * What makes a repeat FRUITLESS is measurable and needs no chosen number: the
 * fragment was appended — hls.js says so with `FRAG_BUFFERED`, which fires
 * after the append, not after the download — and the end of the buffer did not
 * move. Bytes that added nothing to the buffer will add nothing on the next
 * pass either.
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
  /** @type {Map<string, { bufferedEnd: number, fruitless: number }>} */
  let seen = new Map();

  return {
    /**
     * Record one append.
     *
     * @param {{ key: string, bufferedEnd: number }} fragment - `key` identifies
     *   the fragment (its stream, level and sequence number); `bufferedEnd` is
     *   how far the buffer reaches now.
     * @returns {RepeatVerdict}
     */
    note({ key, bufferedEnd }) {
      const end = Number.isFinite(bufferedEnd) ? bufferedEnd : 0;
      const known = seen.get(key);
      if (!known) {
        seen.set(key, { bufferedEnd: end, fruitless: 0 });
        return { fruitless: 0, looping: false, bufferedEnd: end };
      }
      if (end > known.bufferedEnd) {
        // It moved the buffer, so it was worth fetching. The count starts over:
        // what matters is CONSECUTIVE appends that achieved nothing.
        seen.set(key, { bufferedEnd: end, fruitless: 0 });
        return { fruitless: 0, looping: false, bufferedEnd: end };
      }
      const fruitless = known.fruitless + 1;
      seen.set(key, { bufferedEnd: known.bufferedEnd, fruitless });
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
