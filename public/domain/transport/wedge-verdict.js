/**
 * @file Is this transport delivering, or is it gone?
 *
 * The first piece of the transport layer on this side. Pure by construction:
 * plain numbers in, a verdict out. It holds nothing, reads no clock and knows
 * nothing about viewers, playback or requests beyond how many are outstanding.
 *
 * WHY THIS EXISTS. A WebRTC data channel can stop delivering while every layer
 * above it reports health: `connectionState` stays `connected`, ICE stays
 * `completed`, the round trip stays low, and the association simply never puts
 * another byte on the wire. Read out of two live wedged associations
 * 2026-09-13: the sender's congestion window is full, its retransmission timer
 * is not scheduled, and nothing acknowledges what is outstanding, so nothing
 * ever drains. It does not recover — one field episode sat in this state for
 * six hours and fifty minutes. Only a new association carries bytes again.
 *
 * Because the channel never closes, nothing declares the transport lost, and
 * the reconnect ladder — which works, and is proven on a CLOSED channel — never
 * runs. That is why a viewer waits for ever instead of a second.
 */

/**
 * The bound is the caller's own request timeout, and that is deliberate.
 *
 * It is not a number invented here. It already exists, it already means "this
 * request is dead", and this side already reaches it: the field log of
 * 2026-09-12 carries `Data channel request timed out` every 63 seconds while
 * the viewer sat frozen, and nothing drew a conclusion from it.
 *
 * A healthy channel cannot be silent that long. The peer sends a numbered probe
 * roughly twice a second, and every probe counts as a delivery, so silence
 * spanning a whole request timeout is not a slow response — it is nothing
 * arriving at all.
 *
 * A "worst silence observed while healthy" bound was considered and rejected:
 * the worst-observed only ever grows among gaps that did NOT end in a wedge, so
 * the first gap to beat the record would be declared a wedge before it could be
 * recorded as healthy. A rule that misfires on its own best case is not a rule.
 *
 * @param {object}  facts
 * @param {number}  facts.silentMs - Milliseconds since anything at all arrived
 *   on the channel. Counted only while a request is outstanding: with nothing
 *   asked for, silence means nobody asked.
 * @param {number}  facts.pendingRequests - Requests awaiting a response.
 * @param {number}  facts.requestTimeoutMs - The caller's own bound on a request.
 * @param {boolean} facts.channelOpen - Whether the channel still claims to be
 *   open. A closed channel is an ordinary loss and is somebody else's business.
 * @returns {{ wedged: boolean, reason: string }}
 */
export function wedgeVerdict({ silentMs, pendingRequests, requestTimeoutMs, channelOpen }) {
  if (!channelOpen) {
    return { wedged: false, reason: "the channel is closed, which is an ordinary loss" };
  }
  if (!(pendingRequests > 0)) {
    return { wedged: false, reason: "nothing is outstanding, so silence means nobody asked" };
  }
  if (!(requestTimeoutMs > 0)) {
    return { wedged: false, reason: "no request bound was given, so there is nothing to judge against" };
  }
  if (silentMs < requestTimeoutMs) {
    return {
      wedged: false,
      reason: `silent ${Math.round(silentMs)}ms of the ${requestTimeoutMs}ms a request is given`
    };
  }
  return {
    wedged: true,
    reason:
      `nothing arrived for ${Math.round(silentMs)}ms with ${pendingRequests} request(s) waiting — ` +
      `longer than the ${requestTimeoutMs}ms a request is given, on a channel that still calls itself open`
  };
}
