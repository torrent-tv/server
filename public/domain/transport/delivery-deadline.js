/**
 * @file When this connection's next delivery is due, and what its silence means.
 *
 * Pure: plain numbers in, plain answers out. It holds nothing between calls,
 * reads no clock and knows nothing about viewers or playback.
 *
 * WHY THIS EXISTS. A WebRTC data channel can stop delivering while every layer
 * above it reports health: `connectionState` stays `connected`, ICE stays
 * `completed`, the round trip stays low. Read out of two live wedged
 * associations 2026-09-13: the sender's congestion window is full and its
 * retransmission timer is not scheduled, so nothing ever drains, and only a new
 * association carries bytes again (`sctplab/usrsctp#750`). Until 2026-10-04
 * this side noticed only after 60 s of silence — the request timeout — and on
 * 2026-09-28 the viewer's 60 s cushion ran out the second that bound was
 * reached (meta `research/stalled-channel-recovery-2026-10-04.md`).
 *
 * THE MEASURE. The proxy numbers a probe every half second on every channel. A
 * connection that delivers delivers those probes, so the gap between the
 * arrivals of two consecutive probe numbers is this connection's own answer to
 * "how long between deliveries". Each probe NUMBER counts once: the same probe
 * arrives on three channels within milliseconds, and counting each arrival
 * would make the gaps alternate between nearly zero and half a second. Every
 * other message still ends a silence — it is a delivery — but does not feed
 * the estimate.
 *
 * THE ESTIMATE is the mean and mean deviation of those gaps, smoothed with the
 * gains of RFC 6298 §2 (1/8 and 1/4), and the next delivery is due within the
 * mean plus four deviations. RFC 6298 applies this to round-trip times to set a
 * retransmission timeout; here it is ADAPTED to the gaps between heartbeats,
 * which is the same question — how long may the next one take before its
 * absence means something — asked of a different quantity. It is an estimate,
 * not a bound: a gap longer than it is a reason to look, never a verdict on its
 * own.
 *
 * MEASURED BEHAVIOUR, not promised (test/delivery-deadline.test.js): with
 * probes every 500 ± 10 ms the deadline is about 0.54 s. One gap of 21 s — the
 * proxy's main thread blocked for that long, 2026-10-01 — lifts it to 23.6 s;
 * it halves after six more probes (3 s), is under 1.5 s after twenty-four
 * (12 s) and about 0.9 s after thirty (15 s). Until then a stall is noticed
 * later, never earlier.
 */

/** RFC 6298 §2: the gain applied to the mean. */
const MEAN_GAIN = 1 / 8;
/** RFC 6298 §2: the gain applied to the mean deviation. */
const DEVIATION_GAIN = 1 / 4;
/** RFC 6298 §2: how many deviations above the mean the timeout lies. */
const DEVIATION_WEIGHT = 4;

/**
 * @typedef {{ samples: number, meanMs: number, deviationMs: number }} ArrivalEstimate
 */

/** @returns {ArrivalEstimate} */
export function emptyArrivalEstimate() {
  return { samples: 0, meanMs: 0, deviationMs: 0 };
}

/**
 * Take one more gap between two consecutive probe numbers into the estimate.
 *
 * @param {ArrivalEstimate} estimate
 * @param {number} gapMs
 * @returns {ArrivalEstimate}
 */
export function noteProbeGap(estimate, gapMs) {
  if (!(gapMs >= 0) || !Number.isFinite(gapMs)) {
    return estimate;
  }
  if (estimate.samples === 0) {
    return { samples: 1, meanMs: gapMs, deviationMs: gapMs / 2 };
  }
  return {
    samples: estimate.samples + 1,
    meanMs: (1 - MEAN_GAIN) * estimate.meanMs + MEAN_GAIN * gapMs,
    deviationMs: (1 - DEVIATION_GAIN) * estimate.deviationMs + DEVIATION_GAIN * Math.abs(estimate.meanMs - gapMs)
  };
}

/**
 * Within how many milliseconds of the last delivery the next one is due, or
 * null while no gap has been measured — two probes are needed for one gap, and
 * before that nothing about this connection's rhythm is known.
 *
 * @param {ArrivalEstimate} estimate
 * @returns {number | null}
 */
export function deliveryDueWithinMs(estimate) {
  if (!(estimate.samples > 0)) {
    return null;
  }
  return estimate.meanMs + DEVIATION_WEIGHT * estimate.deviationMs;
}

/**
 * What a silence on this connection means right now.
 *
 * `stalled` needs every one of: the channel claims to be open, somebody is
 * waiting for an answer, the rhythm is known, the silence is longer than it,
 * and the transport has no message this page has not yet handled. The last
 * term is what keeps a late timer honest: a check that runs after the page was
 * busy can find messages already received and queued for handling, and those
 * are deliveries, not silence.
 *
 * `lost` is the last resort, for a connection that stays silent for as long as
 * a request is given. It does not need anybody to be waiting at that moment:
 * every request that was waiting has timed out by then, and a rule that
 * required one would never fire.
 *
 * @param {object} facts
 * @param {number} facts.silentMs - Since the last message of any kind.
 * @param {number | null} facts.dueWithinMs - {@link deliveryDueWithinMs}.
 * @param {number} facts.outstanding - Requests awaiting an answer.
 * @param {boolean} facts.channelOpen
 * @param {boolean} facts.messagesWaiting - Received by the transport, not yet handled here.
 * @param {boolean} facts.stalledAlready - Whether this silence was already called stalled.
 * @param {number} facts.requestTimeoutMs - The bound one request is given.
 * @returns {{ state: "delivering" | "cannot-judge" | "stalled" | "lost", reason: string }}
 */
export function silenceVerdict({
  silentMs,
  dueWithinMs,
  outstanding,
  channelOpen,
  messagesWaiting,
  stalledAlready,
  requestTimeoutMs
}) {
  if (!channelOpen) {
    return { state: "cannot-judge", reason: "the channel is closed, which is an ordinary loss" };
  }
  if (messagesWaiting) {
    return { state: "delivering", reason: "messages have arrived and are waiting to be handled" };
  }
  if (stalledAlready && requestTimeoutMs > 0 && silentMs >= requestTimeoutMs) {
    return {
      state: "lost",
      reason: `nothing arrived for ${Math.round(silentMs)}ms — as long as a request is given — on a channel that still calls itself open`
    };
  }
  if (stalledAlready) {
    return { state: "stalled", reason: `still nothing after ${Math.round(silentMs)}ms` };
  }
  if (!(outstanding > 0)) {
    return { state: "delivering", reason: "nothing is outstanding, so silence means nobody asked" };
  }
  if (dueWithinMs === null) {
    return { state: "cannot-judge", reason: "no gap between probes has been measured yet" };
  }
  if (silentMs <= dueWithinMs) {
    return { state: "delivering", reason: `silent ${Math.round(silentMs)}ms of the ${Math.round(dueWithinMs)}ms the next delivery may take` };
  }
  return {
    state: "stalled",
    reason:
      `nothing arrived for ${Math.round(silentMs)}ms with ${outstanding} request(s) waiting — ` +
      `the next delivery was due within ${Math.round(dueWithinMs)}ms`
  };
}
