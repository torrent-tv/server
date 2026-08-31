/**
 * @file What the browser's own media buffer says, and how fast it is filling.
 *
 * Both figures are derived from `video.buffered` and from nothing else. Neither
 * can come from the proxy: the proxy knows what it SENT, and the two disagree
 * exactly when it matters — a proxy reporting "100%" while the player's buffer
 * sat at 0.0 s and the picture had been frozen for minutes is the measured case
 * that moved every progress figure onto this side (server 0.8.87).
 *
 * Pure. The history a fill rate needs is held by whoever samples — the player,
 * which owns the element — and passed in, so there is no state here and no
 * class wanted.
 */

/**
 * The largest gap between two buffered ranges that still counts as one run of
 * media.
 *
 * Segment joins are not always exact. Measured 2026-08-14 on a copied video cut
 * at the container's own keyframes: hls.js reported the buffer as
 * `[{start:2275.609,end:2290.648999},{start:2290.708,end:2301.139999}]` — a
 * 0.059 s gap at a join — and on another run a 0.170 s one. Read as the end of
 * the buffer, such a gap cost 45 s of every cold start: the gate saw 10 s where
 * 130 s were held and waited out its whole timeout.
 *
 * Half a second is far larger than any join artefact and far smaller than a
 * missing segment (segments here run 4-10 s), so it cannot hide a real hole.
 * The player is configured with the same figure and merges on the same rule —
 * a gap of exactly this much is NOT merged by either.
 *
 * The player only honours it while it is PLAYING: hls.js substitutes zero
 * whenever the element is paused, which is the whole of our cold start. So this
 * figure describes what the two sides agree on once the picture is moving, and
 * the wedge it causes before then is dealt with where the prebuffer waits.
 */
export const MAX_BUFFER_HOLE_SECONDS = 0.5;

/**
 * How many seconds of media sit ahead of the playhead.
 *
 * Counts from the range holding the playhead and continues across gaps up to
 * {@link MAX_BUFFER_HOLE_SECONDS}, because the player steps over those by
 * itself. A larger gap ends the count: media past it is not playable until the
 * gap is filled, and counting it would report a comfortable cushion over a
 * picture about to stop. The 0.25 s slack absorbs the ordinary case where the
 * range starts a few frames after the position the element reports.
 *
 * @param {HTMLVideoElement | null} video
 * @returns {number} Seconds ahead, or 0 when nothing playable is buffered.
 */
export function bufferedAheadSeconds(video) {
  if (!video || typeof video.currentTime !== "number" || !video.buffered) {
    return 0;
  }
  const { buffered, currentTime } = video;
  for (let index = 0; index < buffered.length; index += 1) {
    if (buffered.start(index) <= currentTime + 0.25 && currentTime < buffered.end(index)) {
      let end = buffered.end(index);
      for (let next = index + 1; next < buffered.length; next += 1) {
        if (buffered.start(next) - end >= MAX_BUFFER_HOLE_SECONDS) {
          break;
        }
        end = buffered.end(next);
      }
      return end - currentTime;
    }
  }
  return 0;
}

/**
 * How much ALREADY PLAYED media is still buffered behind the playhead.
 *
 * This is the quantity a browser evicts from when a SourceBuffer runs out of
 * room: a media element may only free coded frames the playhead has passed. It
 * is therefore also the reason a refusal to buffer deeper says nothing durable
 * when it arrives at the start of a film — there is nothing behind the playhead
 * to free, `QuotaExceededError` is certain whatever the device could really
 * hold, and the same depth fits without complaint ten minutes later.
 *
 * @param {HTMLVideoElement | null | undefined} video
 * @returns {number} Seconds, zero when the playhead is in no buffered range.
 */
export function bufferedBehindSeconds(video) {
  if (!video || typeof video.currentTime !== "number" || !video.buffered) {
    return 0;
  }
  const { buffered, currentTime } = video;
  for (let index = 0; index < buffered.length; index += 1) {
    if (buffered.start(index) <= currentTime + 0.25 && currentTime < buffered.end(index)) {
      let start = buffered.start(index);
      for (let previous = index - 1; previous >= 0; previous -= 1) {
        if (start - buffered.end(previous) >= MAX_BUFFER_HOLE_SECONDS) {
          break;
        }
        start = buffered.start(previous);
      }
      return Math.max(0, currentTime - start);
    }
  }
  return 0;
}

/**
 * Where the media the player already holds runs out, in seconds on the
 * timeline.
 *
 * This is where a quality change actually lands. The player keeps what it has
 * buffered and appends the new rung AFTER it — so the first segment the new
 * rung must supply is the one at this time, not the one under the playhead.
 * Measured 2026-08-12: three switches were prepared at the playhead and the
 * player then asked for a segment 11 s, 14 s and 50 s further on, each time
 * finding nothing there and stalling — the spinner the preparation exists to
 * prevent.
 *
 * @param {HTMLVideoElement | null} video
 * @returns {number} The end of the range holding the playhead, or the playhead
 *   itself when nothing playable is buffered.
 */
export function bufferedEndSeconds(video) {
  if (!video || typeof video.currentTime !== "number") {
    return 0;
  }
  return video.currentTime + bufferedAheadSeconds(video);
}

/**
 * One reading of the buffer, taken at a moment.
 *
 * @typedef {object} BufferSample
 * @property {number} atMs - When it was taken.
 * @property {number} aheadSeconds - What {@link bufferedAheadSeconds} said.
 * @property {number} [playheadSeconds] - Where the playhead stood. The rate
 *   credits media consumed by playback, and only the playhead can say how much
 *   was consumed — a stalled element is not paused, yet plays nothing.
 */

/** Samples older than this say nothing about the rate right now. */
const FILL_RATE_WINDOW_MS = 10_000;

/** Below this many samples a slope is noise, not a measurement. */
const FILL_RATE_MIN_SAMPLES = 3;

/**
 * How fast the buffer is filling, in seconds of media per second of wall clock.
 *
 * This is the END-TO-END rate: it is the result of the torrent download, the
 * encoder, the data channel and the browser's own decoding, so it prices in
 * every bottleneck at once — including the ones no single stage can see. That
 * is why it is worth measuring here rather than assembling from the stages.
 *
 * Above 1 means the buffer is growing faster than it is being watched. Below 1
 * means it is losing ground even while data arrives.
 *
 * Measured over a window rather than between the last two samples: a segment
 * arrives whole, so consecutive readings alternate between a jump and a flat
 * stretch, and either one taken alone is wrong by the length of a segment.
 *
 * @param {BufferSample[]} samples - In the order taken, oldest first.
 * @param {number} [nowMs] - Present time; samples older than the window are
 *   ignored.
 * @returns {number | null} Null when there is not enough to say — which is a
 *   real answer, and must not be replaced by a guess.
 */
export function fillRateFromSamples(samples, nowMs = Date.now()) {
  if (!Array.isArray(samples)) {
    return null;
  }
  const recent = samples.filter((sample) => nowMs - sample.atMs <= FILL_RATE_WINDOW_MS);
  if (recent.length < FILL_RATE_MIN_SAMPLES) {
    return null;
  }
  const first = recent[0];
  const last = recent[recent.length - 1];
  const elapsedSeconds = (last.atMs - first.atMs) / 1000;
  if (elapsedSeconds <= 0) {
    return null;
  }
  // Media gained, plus — ONLY while the picture is moving — the media consumed
  // by playing it: a buffer holding steady during playback is being filled at
  // exactly 1x, not at 0.
  //
  // While the viewer is WAITING nothing is consumed, and crediting the wait as
  // if it were is what made a completely frozen buffer report 1.00x. Measured
  // 2026-08-10: six waits in a row, every one tagged `@1.00x-measured`, every
  // one underestimated — because the shortfall was divided by a rate that
  // described nothing. The same formula at the other extreme produced 586.9
  // seconds. A buffer that is not moving is filling at zero, and the honest
  // consequence is that no time can be given, not that it is the shortfall.
  const gained = last.aheadSeconds - first.aheadSeconds;
  // How much was actually PLAYED, taken from the playhead itself rather than
  // from a flag. `!video.paused` says the element intends to play, which during
  // a stall is true while the picture stands still — so crediting a wait by that
  // flag put `@1.00x` back on frozen buffers. The playhead cannot be wrong about
  // this: if it did not move, nothing was consumed, whatever the element intended.
  const played = Math.max(0, (last.playheadSeconds ?? 0) - (first.playheadSeconds ?? 0));
  return (gained + played) / elapsedSeconds;
}

/**
 * Add a reading and drop the ones that have aged out.
 *
 * @param {BufferSample[]} samples
 * @param {BufferSample} sample
 * @returns {BufferSample[]} A new array; the input is not modified.
 */
export function withSample(samples, sample) {
  const kept = Array.isArray(samples) ? samples : [];
  return [...kept, sample].filter((each) => sample.atMs - each.atMs <= FILL_RATE_WINDOW_MS);
}
