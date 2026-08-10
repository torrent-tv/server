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
 * How many seconds of media sit ahead of the playhead.
 *
 * Only the buffered range CONTAINING the playhead counts. Ranges after a gap
 * are not playable without the gap being filled first, and counting them would
 * report a comfortable cushion over a picture that is about to stop. The 0.25 s
 * slack absorbs the ordinary case where the range starts a few frames after the
 * position the element reports.
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
      return buffered.end(index) - currentTime;
    }
  }
  return 0;
}

/**
 * One reading of the buffer, taken at a moment.
 *
 * @typedef {object} BufferSample
 * @property {number} atMs - When it was taken.
 * @property {number} aheadSeconds - What {@link bufferedAheadSeconds} said.
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
 * @param {boolean} [playing] - Whether the picture is moving. Only then is the
 *   media consumed by playback credited to the rate.
 * @returns {number | null} Null when there is not enough to say — which is a
 *   real answer, and must not be replaced by a guess.
 */
export function fillRateFromSamples(samples, nowMs = Date.now(), playing = false) {
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
  const consumed = playing ? elapsedSeconds : 0;
  return (gained + consumed) / elapsedSeconds;
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
