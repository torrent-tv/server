/**
 * @file How fast is this link, before any film has been chosen?
 *
 * A viewer's link is measured from completed transfers, and until 2026-09-14
 * the only transfers that counted were segments of the film — so the figure
 * existed only after playback had begun, which is after every decision that
 * wants it has been taken. The quality offer at a cold open was made with no
 * measurement of the link at all, and the report carrying the viewer's own
 * facts was skipped for want of one.
 *
 * There is nothing to wait for. The proxy can send bytes the moment the channel
 * is up, and the page connects to a proxy when it OPENS, before a torrent has
 * been dropped — so the measurement happens while the person is still finding
 * their film, and costs the viewing nothing.
 *
 * THE SIZE IS DERIVED, NEVER CHOSEN. A transfer shorter than the timer's own
 * noise measures the timer; so the first ask is one channel message, and if it
 * came back too quickly to time, the next ask is the size that the rate just
 * observed would take the minimum measurable time to deliver. A slow link is
 * measured in one ask of 64 KiB; a fast one grows until it is measurable, and
 * stops at a ceiling that is itself derived — see `MAX_PROBE_BYTES`.
 *
 * Pure sizing here, the driving beside it: plain numbers in, the next size out.
 */

/**
 * The first ask: one data-channel message.
 *
 * Not a round number picked for looking tidy — it is the size the transport
 * already splits its bodies into, so it is one message on the wire and the
 * smallest ask that is not a fraction of one.
 */
export const FIRST_PROBE_BYTES = 65536;

/**
 * The largest ask, and what makes it that number.
 *
 * The figure is only ever used to decide what this link can carry, and the most
 * anything this product offers is a 1080p rung at around 12 Mbit/s. Two
 * mebibytes delivered inside the minimum measurable time is 336 Mbit/s — some
 * twenty-eight times the top rung. A link that still cannot be timed at that
 * size is faster than any decision here could distinguish, so growing further
 * buys nothing and spends a proxy owner's uplink.
 */
export const MAX_PROBE_BYTES = 2 * 1024 * 1024;

/**
 * How many measurable transfers the estimate needs before it means anything.
 *
 * The same two the median over segments needs, and for the same reason: one
 * reading cannot be told apart from one accident.
 */
export const PROBE_SAMPLES = 2;

/**
 * The next size to ask for, or null when there is nothing left to learn.
 *
 * @param {object} state
 * @param {number} state.lastBytes - What was just asked for.
 * @param {number} state.lastMs - How long its transfer took.
 * @param {number} state.measurableSoFar - Transfers so far that took at least
 *   `minSampleMs`, and so said something about the link.
 * @param {number} state.minSampleMs - Below this a transfer measures the timer.
 * @returns {number | null}
 */
export function nextProbeBytes({ lastBytes, lastMs, measurableSoFar, minSampleMs }) {
  if (measurableSoFar >= PROBE_SAMPLES) {
    return null;
  }
  if (lastMs >= minSampleMs) {
    // Measurable at this size: ask again at the same size until there are
    // enough readings to have a median.
    return lastBytes;
  }
  if (lastBytes >= MAX_PROBE_BYTES) {
    // Too quick to time even at the ceiling. Nothing further is worth spending:
    // this link is beyond what any decision here separates.
    return null;
  }
  // Too quick to time. The rate just observed — bytes over the time it took,
  // and a transfer that registered no time at all is bounded below by one
  // millisecond — says how many bytes that same rate needs to fill the minimum
  // measurable time.
  const perMs = lastBytes / Math.max(lastMs, 1);
  const needed = Math.ceil(perMs * minSampleMs);
  return Math.min(MAX_PROBE_BYTES, Math.max(needed, lastBytes * 2));
}
