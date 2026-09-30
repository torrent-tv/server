/**
 * Present the proxy's playback forecast alongside the browser's measured
 * buffer. This file contains no readiness rule or rate estimate; the proxy's
 * `playbackReadiness` response is the only authority for starting playback.
 */
export class WaitingModel {
  #readiness = null;
  #bufferedAhead = null;

  /**
   * @param {object} facts
   * @returns {{ etaSeconds: number | null, cushionPercent: number | null,
   *   cushionRemainingSeconds: number | null, encodeSpeedText: null }}
   */
  update(facts = {}) {
    if (Object.hasOwn(facts, "playbackReadiness")) {
      this.#readiness = facts.playbackReadiness && typeof facts.playbackReadiness === "object"
        ? facts.playbackReadiness
        : null;
    }
    if (typeof facts.bufferedAhead === "number" && Number.isFinite(facts.bufferedAhead) && facts.bufferedAhead >= 0) {
      this.#bufferedAhead = facts.bufferedAhead;
    }
    const readiness = this.#readiness;
    const reserve = Number(readiness?.reserveSeconds);
    const proxyBuffer = Number(readiness?.bufferedSeconds);
    const ahead = this.#bufferedAhead ?? (Number.isFinite(proxyBuffer) ? proxyBuffer : null);
    const ready = readiness?.ready === true;
    const delay = readiness?.delaySeconds;
    const etaSeconds = ready
      ? 0
      : Number.isFinite(delay) && delay >= 0
        ? delay
        : null;
    const cushionRemainingSeconds = Number.isFinite(reserve) && reserve > 0 && ahead !== null
      ? Math.max(0, reserve - ahead)
      : null;
    const cushionPercent = ready
      ? 100
      : Number.isFinite(reserve) && reserve > 0 && ahead !== null
        ? Math.max(0, Math.min(100, (ahead / reserve) * 100))
        : null;

    return {
      etaSeconds,
      cushionPercent,
      cushionRemainingSeconds,
      encodeSpeedText: null
    };
  }

  /** The old client-side readiness calculation has been removed. */
  reset() {
    this.#readiness = null;
    this.#bufferedAhead = null;
  }
}
