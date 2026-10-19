/**
 * Present the proxy's playback forecast alongside the browser's measured
 * buffer. This file contains no readiness rule or rate estimate; the proxy's
 * `playbackReadiness` response is the only authority for starting playback.
 */
export class WaitingModel {
  #readiness = null;
  #waitEstimateKey = null;
  #waitEstimateDeadline = null;
  #waitEstimateId = null;
  #waitEstimateRevision = -1;
  #bufferedAhead = null;
  #clock;

  constructor({ clock = () => performance.now() } = {}) {
    this.#clock = clock;
  }

  /**
   * @param {object} facts
   * @returns {{ etaSeconds: number | null, cushionPercent: number | null,
   *   cushionRemainingSeconds: number | null, encodeSpeedText: null }}
   */
  update(facts = {}) {
    const now = this.#clock();
    if (Object.hasOwn(facts, "waitEstimate")) {
      const next = facts.waitEstimate && typeof facts.waitEstimate === "object" &&
        facts.waitEstimate.version === 1 && typeof facts.waitEstimate.waitId === "string" &&
        Number.isSafeInteger(facts.waitEstimate.revision) && facts.waitEstimate.revision >= 0 &&
        Number.isFinite(facts.waitEstimate.remainingSeconds) && facts.waitEstimate.remainingSeconds >= 0 &&
        Number.isFinite(facts.waitEstimate.ageMs) && facts.waitEstimate.ageMs >= 0
        ? facts.waitEstimate : null;
      const clear = facts.waitEstimate === null;
      const key = next ? `${next.waitId}:${next.revision}` : null;
      const stale = next && next.waitId === this.#waitEstimateId &&
        next.revision < this.#waitEstimateRevision;
      if (clear || (next && !stale && key !== this.#waitEstimateKey)) {
        this.#waitEstimateDeadline = next
          ? now + Math.max(0, next.remainingSeconds * 1000 - next.ageMs)
          : null;
        this.#waitEstimateRevision = next?.revision ?? -1;
        this.#waitEstimateId = next?.waitId ?? null;
        this.#waitEstimateKey = key;
      }
    }
    if (Object.hasOwn(facts, "playbackReadiness")) {
      const next = facts.playbackReadiness && typeof facts.playbackReadiness === "object"
        ? facts.playbackReadiness
        : null;
      this.#readiness = next;
    }
    if (typeof facts.bufferedAhead === "number" && Number.isFinite(facts.bufferedAhead) && facts.bufferedAhead >= 0) {
      this.#bufferedAhead = facts.bufferedAhead;
    }
    const readiness = this.#readiness;
    const reserve = Number(readiness?.reserveSeconds);
    const proxyBuffer = Number(readiness?.bufferedSeconds);
    const ahead = this.#bufferedAhead ?? (Number.isFinite(proxyBuffer) ? proxyBuffer : null);
    const ready = readiness?.ready === true;
    const earlyCountdown = Number.isFinite(this.#waitEstimateDeadline)
      ? (this.#waitEstimateDeadline - now) / 1000 : null;
    const earlyEta = Number.isFinite(earlyCountdown) && earlyCountdown > 0 ? earlyCountdown : null;
    // An unready playback-readiness delay describes its current constraint,
    // not the full remaining time to the first presented frame.
    // Only the early wait estimate covers that complete end-to-end wait.
    const etaSeconds = earlyEta;
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
      reason: earlyEta !== null ? "initial-playback-estimate" : readiness?.reason ?? "forecast-not-received",
      cushionPercent,
      cushionRemainingSeconds,
      encodeSpeedText: null
    };
  }

  /** The old client-side readiness calculation has been removed. */
  reset() {
    this.#readiness = null;
    this.#waitEstimateKey = null;
    this.#waitEstimateDeadline = null;
    this.#waitEstimateId = null;
    this.#waitEstimateRevision = -1;
    this.#bufferedAhead = null;
  }
}
