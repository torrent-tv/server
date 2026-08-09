import { getEstimatedLinkMbps } from "./net-report.js";

/**
 * @file The waiting model: raw facts in, the figures the viewer is shown out.
 *
 * A Humble Object split. The overlay that shows these numbers is a view, and a
 * view with arithmetic in it can only be checked by looking at it. Everything
 * that decides WHAT the figures are lives here instead — no DOM, no events, no
 * element — so `node --test` can pin it, and the view is left with subscribing
 * and rendering.
 *
 * It is a class rather than a set of functions because it genuinely has state:
 * a short history of download rates, the floor that stops the shown countdown
 * jumping about, and the samples that later score how honest the estimate was.
 *
 * Two consumers, one implementation: the overlay reads these figures to show
 * them, and the pre-buffer gate reads them to decide when the picture may
 * start. They must never disagree, which is why neither of them computes.
 */

const ENCODE_SPEED_MIN_PRODUCED_SECONDS = 2;

const SEGMENT_DURATION_SECONDS = 4;

/** How long the download-rate trend is worth extrapolating from. */
const RATE_TREND_WINDOW_MS = 6_000;
/** The most a rate is allowed to be assumed to grow, so a floor stays a floor. */
const RATE_TREND_MAX_GROWTH = 4;



/**
 * @typedef {object} WaitingFacts
 * @property {number} [bufferedAhead] - Seconds of media ahead of the playhead,
 *   measured by whoever owns the element. The single most important input: the
 *   picture starts when this reaches the cushion and at no other moment.
 * @property {object} [downloadStats] - The proxy's answer about the torrent.
 * @property {object} [transcodeProgress] - The proxy's answer about the encode.
 * @property {number} [expectedFirstSegmentSeconds] - What this host usually
 *   takes to produce a first segment.
 * @property {number} [expectedSessionCreateSeconds] - …and to create a session.
 * @property {{ video: boolean, audio: boolean }} [encodingTracks] - Which
 *   tracks are being re-encoded rather than copied.
 */

export class WaitingModel {
  /** @type {number | null} Seconds of media ahead of the playhead. */
  #bufferedAhead = null;
  /** @type {Array<{ atMs: number, bytes: number }>} Recent download readings. */
  #downloadRateSamples = [];
  /** @type {number | null} The smallest figure promised so far, in seconds. */
  #etaPromise = null;
  /** @type {number} When that promise was made. */
  #etaPromiseAt = 0;
  /** @type {Array<object>} Estimates against what actually happened. */
  #etaSamples = [];
  /** @type {number | null} */
  #expectedFirstSegmentSeconds = null;
  /** @type {number | null} */
  #expectedSessionCreateSeconds = null;
  /** @type {Array<number>} Cushions at which playback actually began. */
  #playbackStartBuffers = [];
  /** @type {{ video: boolean, audio: boolean }} */
  #encodingTracks = { video: false, audio: false };
  /** @type {boolean} Whether the step on screen came from the pipeline. */
  #stageFromPipeline = false;

  /**
   * Take in whatever has just been measured, and answer with the figures.
   * Fields absent from `facts` keep their previous value: readings arrive at
   * different rates and from different places, and one of them being late must
   * not blank the rest.
   *
   * @param {WaitingFacts} facts
   * @returns {{ etaSeconds: number | null, cushionPercent: number | null,
   *   cushionRemainingSeconds: number | null, encodeSpeedText: string | null }}
   */
  update(facts = {}) {
    if (typeof facts.bufferedAhead === "number") {
      this.#bufferedAhead = facts.bufferedAhead;
    }
    if (typeof facts.expectedFirstSegmentSeconds === "number") {
      this.#expectedFirstSegmentSeconds = facts.expectedFirstSegmentSeconds;
    }
    if (typeof facts.expectedSessionCreateSeconds === "number") {
      this.#expectedSessionCreateSeconds = facts.expectedSessionCreateSeconds;
    }
    if (facts.encodingTracks) {
      this.#encodingTracks = facts.encodingTracks;
    }
    return this.#computeUnifiedEta(facts.downloadStats ?? null, facts.transcodeProgress ?? null);
  }

  /** Every encoder run still going, for the overlay to list one line each. */
  describeEncodingRuns(transcodeProgress, unified) {
    return this.#describeEncodingRuns(transcodeProgress, unified);
  }

  /** How much cushion this viewer needs before the picture may start. */
  requiredBufferSeconds() {
    return this.#requiredBufferSeconds();
  }

  /** Score the estimates of the wait that just ended. */
  reportEtaAccuracy() {
    this.#reportEtaAccuracy();
  }

  /** A wait that has ended takes its history with it. */
  reset() {
    this.#downloadRateSamples = [];
    this.#resetEtaFloor();
  }

  /**
   * @param {string} message
   * @returns {void}
   */
  #logEvt(message) {
    console.debug(`[evt] ${new Date().toISOString().slice(11, 23)} ${message}`);
  }

  /**
   * How close playback is to (re)starting, and how long that will take.
   *
   * The figure the viewer is shown MUST describe the thing they are waiting
   * for — playback starting — so it is measured where that is actually
   * decided: **the browser's own buffer**. Playback begins when enough media
   * is buffered ahead of the playhead ({@link PREBUFFER_TARGET_SECONDS}) and
   * at no other moment, so:
   *
   *   - `cushionPercent`          = buffered-ahead / target
   *   - `cushionRemainingSeconds` = target - buffered-ahead
   *   - `etaSeconds`              = remaining / the MEASURED rate at which the
   *                                 buffer is actually filling
   *
   * The buffer's fill rate is the end result of the whole pipeline (torrent
   * download → ffmpeg → data channel → MediaSource), so it prices in every
   * bottleneck at once, including ones no single stage can see.
   *
   * This replaces an earlier version that measured the PROXY's transcode
   * progress instead. That was the wrong quantity and it lied in the field
   * (2026-08-01): after a seek, ffmpeg had produced 110 s of content — a
   * legitimate "100%" by that measure — while the browser's buffer sat at 0.0 s
   * and playback never started, because the segments were being rejected on
   * arrival. The display read "Transcoding — 100% • starting now" for minutes
   * on a player that was frozen. A progress figure taken upstream of the actual
   * failure point can always disagree with reality like this; one taken at the
   * buffer cannot.
   *
   * When the buffer is not filling, the honest answer is "unknown", not a
   * number derived from the stages that DO have a rate — so `etaSeconds` is
   * null and the caller shows "estimating…" rather than "starting now".
   *
   * @param {{ downloadSpeed?: number, resumeNeededBytes?: number | null, resumeDownloadedBytes?: number | null } | null} downloadStats
   *   Retained for the caller's stage text; the estimate itself is measured at
   *   the buffer, so these no longer feed it.
   * @param {{ processedSeconds?: number, startPositionSeconds?: number, speed?: string } | null} transcodeProgress
   * @returns {{
   *   etaSeconds: number | null,
   *   cushionPercent: number | null,
   *   cushionRemainingSeconds: number | null,
   *   encodeSpeedText: string | null
   * }}
   */
  #computeUnifiedEta(downloadStats, transcodeProgress) {
    // How much media the player actually has ahead of the playhead. This — not
    // the proxy's encode progress — is what gates playback starting.
    const bufferedAhead = this.#bufferedAhead;

    let cushionPercent = null;
    let cushionRemainingSeconds = null;
    let etaSeconds = null;
    let fillRate = null;
    // Which of the four measurements produced the number the viewer sees. It
    // is ONE figure — seconds until playback starts — but it is measured
    // wherever it can be measured best at that instant, and when a shown number
    // turns out wrong, the first question is always which of them said it.
    let etaSource = "none";

    // Bytes still to arrive before playback can proceed — the proxy's resume
    // window mid-playback, the file header on the very first open. Used only as
    // a floor (see below), never to declare readiness.
    const neededBytes = downloadStats && typeof downloadStats.resumeNeededBytes === "number"
      ? downloadStats.resumeNeededBytes : null;
    const downloadedBytes = downloadStats && typeof downloadStats.resumeDownloadedBytes === "number"
      ? downloadStats.resumeDownloadedBytes : null;
    const downloadSpeed = downloadStats && typeof downloadStats.downloadSpeed === "number"
      ? downloadStats.downloadSpeed : 0;
    let downloadEtaSeconds = null;
    if (neededBytes !== null && downloadedBytes !== null) {
      // Recorded even at zero — the very first tick of a cold torrent reads
      // 0 KB/s, and skipping it left the NEXT tick with a single sample and no
      // slope, which is why the first figure shown was still the unprojected
      // one: 21.3 s against a real 7.9 s. With the zero kept, the same moment
      // projects to 7.6 s.
      this.#recordDownloadRate(downloadSpeed);
      const remainingBytes = Math.max(0, neededBytes - downloadedBytes);
      if (remainingBytes > 0 && downloadSpeed > 0) {
        downloadEtaSeconds = this.#projectDownloadEta(remainingBytes, downloadSpeed);
      }
    }

    // ONE number, and it is a SUM of the stages that have not happened yet —
    // not a choice between figures that each describe only one of them. Choosing
    // made the number answer "how long until the NEXT stage ends", and its
    // meaning changed as stages completed: measured 2026-08-05, it jumped from
    // 5.5 s to 15 s the instant the download finished, and printed 0.00 for four
    // seconds with an empty buffer. Every term below is a measurement, and each
    // is zero once its stage is done, so the total can only fall.
    // Reasoning and the field numbers behind each term:
    // research/playback-eta-2026-08-05.md.
    //
    //   T = bytes still missing / measured download rate
    //     + creating the session       (0 once it exists)
    //     + producing a first segment  (0 once one has been produced)
    //     + media still needed / the rate at which media arrives
    const processedSeconds = transcodeProgress && typeof transcodeProgress.processedSeconds === "number"
      ? transcodeProgress.processedSeconds : null;
    const startPositionSeconds = transcodeProgress && typeof transcodeProgress.startPositionSeconds === "number"
      ? transcodeProgress.startPositionSeconds : 0;
    const parsedEncodeSpeed = transcodeProgress ? this.#parseSpeedMultiplier(transcodeProgress.speed) : NaN;
    const producedSinceResume = processedSeconds !== null
      ? Math.max(0, processedSeconds - startPositionSeconds)
      : null;
    const encodeSpeed =
      Number.isFinite(parsedEncodeSpeed) &&
      parsedEncodeSpeed > 0 &&
      producedSinceResume !== null &&
      producedSinceResume >= ENCODE_SPEED_MIN_PRODUCED_SECONDS
        ? parsedEncodeSpeed
        : null;

    /** @type {string[]} */
    const terms = [];
    let total = 0;

    // 1. The data. Zero once the bytes the proxy is waiting for have arrived.
    if (downloadEtaSeconds !== null && downloadEtaSeconds > 0) {
      total += downloadEtaSeconds;
      terms.push(`dl=${downloadEtaSeconds.toFixed(1)}`);
    }

    // 2. Creating the session. Zero once one exists — which is exactly what a
    //    progress report proves. The figure is this host's own median.
    const sessionExists = processedSeconds !== null;
    if (!sessionExists && this.#expectedSessionCreateSeconds !== null) {
      total += this.#expectedSessionCreateSeconds;
      terms.push(`create=${this.#expectedSessionCreateSeconds.toFixed(1)}`);
    }

    // 3. Producing a first segment. Zero once the encoder has produced
    //    anything at all. Also this host's own median, and it differs by an
    //    order of magnitude between copying (0.8-1.5 s) and re-encoding (~7 s),
    //    which is why it is measured per host rather than assumed.
    const producedAnything = producedSinceResume !== null && producedSinceResume > 0;
    if (!producedAnything && this.#expectedFirstSegmentSeconds !== null) {
      total += this.#expectedFirstSegmentSeconds;
      terms.push(`first=${this.#expectedFirstSegmentSeconds.toFixed(1)}`);
    }

    // 4. Getting enough media into the player. How much is enough is not a
    //    number we may choose: it is what THIS player did the last few times it
    //    started, which the browser already records at every `playing` event
    //    (0.5 s, 2.0 s and 20.0 s in three measured cases). Before any such
    //    measurement exists the floor is one segment, because no player starts
    //    on less than one.
    const requiredBuffer = this.#requiredBufferSeconds();
    cushionRemainingSeconds = bufferedAhead === null
      ? requiredBuffer
      : Math.max(0, requiredBuffer - bufferedAhead);
    cushionPercent = bufferedAhead === null
      ? 0
      : Math.max(0, Math.min(100, (bufferedAhead / requiredBuffer) * 100));
    if (cushionRemainingSeconds <= 0) {
      // The wait is over — the player has what it needs. Whatever was promised
      // described THIS wait, and the next one is a different question, so the
      // countdown is released here. Without it the promise outlived the wait
      // that made it: measured 2026-08-06, the sum said 3.5 s on an empty
      // buffer and the viewer was shown 0.00 — "starting now" — for the whole
      // of it, because an earlier wait had ended at zero and the guard pinned
      // everything after it there. The reset used to happen only on a seek or a
      // new attempt, and neither of those is what ends an ordinary wait.
      this.#resetEtaFloor();
    }
    if (cushionRemainingSeconds > 0) {
      // How fast media can arrive: the slower of what the encoder produces and
      // what the link can carry. Both measured; when neither has been observed
      // yet the neutral assumption is exactly realtime, which is the definition
      // of the pipeline keeping up rather than a tuned value.
      const linkRate = this.#measuredLinkMediaRate(
        transcodeProgress && typeof transcodeProgress.outputMbps === "number"
          ? transcodeProgress.outputMbps
          : null
      );
      const rates = [encodeSpeed, linkRate].filter((rate) => typeof rate === "number" && rate > 0);
      const arrivalRate = rates.length > 0 ? Math.min(...rates) : 1;
      const fillSeconds = cushionRemainingSeconds / arrivalRate;
      total += fillSeconds;
      terms.push(`fill=${fillSeconds.toFixed(1)}@${arrivalRate.toFixed(2)}x`);
    }

    etaSeconds = total;
    etaSource = terms.length > 0 ? terms.join("+") : "ready";

    // A countdown that goes UP is worse than no countdown: the viewer reads it
    // as the wait growing. Twice in the measured session it did — 5.5 -> 15.0
    // when the download finished and the estimate fell back to an assumption,
    // and 11.9 -> 13.7 while the buffer sat still and its measured fill rate
    // decayed. Both were the SAME wait, so the honest figure is the smaller:
    // whatever was promised, minus the time that has since passed. A real event
    // — a seek, a new file — clears it (see #resetEtaFloor).
    etaSeconds = this.#applyMonotonicEta(etaSeconds);
    this.#etaSamples.push({ atMs: Date.now(), predicted: etaSeconds, terms: etaSource });

    const result = {
      etaSeconds,
      cushionPercent,
      // Seconds of media still needed in the BUFFER before playback starts.
      cushionRemainingSeconds,
      // One decimal, and null while the measurement is still a start-up
      // artefact — so the display can never read "0.00757x realtime".
      encodeSpeedText: encodeSpeed !== null ? `${encodeSpeed.toFixed(1)}x realtime` : null,
      // Exposed so #waitForPrebuffer's early-start heuristic reads the SAME
      // measurement this function used for cushionPercent, instead of
      // re-sampling #trackBufferFillRate a second time (which would corrupt
      // its rolling window — it is stateful, one sample per call).
      fillRate
    };
    // [eta] TEMPORARY: raw inputs + result on every computation, so a field
    // report of a stuck/wrong percent can be verified from the server log
    // (client-logger.js forwards console.debug there — readable via `ssh do`,
    // no device access needed) instead of reasoned about from a screenshot.
    console.debug(
      `[eta] buffered=${bufferedAhead?.toFixed(2) ?? "n/a"} fillRate=${fillRate?.toFixed(3) ?? "n/a"} ` +
        `remaining=${cushionRemainingSeconds?.toFixed(2) ?? "n/a"} downloadEta=${downloadEtaSeconds?.toFixed(2) ?? "n/a"} ` +
        `proxyProcessed=${processedSeconds} proxyStartPos=${startPositionSeconds} ` +
        `proxyProduced=${producedSinceResume?.toFixed(2) ?? "n/a"} speedRaw=${transcodeProgress?.speed ?? "n/a"} ` +
        `dlSpeed=${Math.round(downloadSpeed / 1024)}KB/s ` +
        `dlRemaining=${neededBytes !== null && downloadedBytes !== null ? Math.round(Math.max(0, neededBytes - downloadedBytes) / 1024) : "n/a"}KB ` +
        `=> source=${etaSource} cushionPercent=${cushionPercent?.toFixed(1) ?? "null"} ` +
        `etaSeconds=${etaSeconds?.toFixed(2) ?? "null"}`
    );
    return result;
  }

  #recordDownloadRate(speedNow) {
    const now = Date.now();
    this.#downloadRateSamples.push({ at: now, speed: Math.max(0, speedNow) });
    while (
      this.#downloadRateSamples.length > 2 &&
      now - this.#downloadRateSamples[0].at > RATE_TREND_WINDOW_MS
    ) {
      this.#downloadRateSamples.shift();
    }
  }

  #projectDownloadEta(remainingBytes, speedNow) {
    const now = Date.now();
    const oldest = this.#downloadRateSamples[0] ?? { at: now, speed: speedNow };
    const spanSeconds = (now - oldest.at) / 1000;
    // Only a RISING rate is projected. A falling one is left alone: it may be
    // the swarm losing peers, and shortening the estimate on the strength of
    // that would be optimism with nothing behind it.
    const slope = spanSeconds > 0.5 ? Math.max(0, (speedNow - oldest.speed) / spanSeconds) : 0;

    const steady = remainingBytes / speedNow;
    if (slope <= 0) {
      return steady;
    }
    const ramped =
      (-speedNow + Math.sqrt(speedNow * speedNow + 2 * slope * remainingBytes)) / slope;
    // A noisy pair of samples can imply a climb that will not happen, so the
    // projection may not claim an average faster than a few times what is
    // being achieved now.
    const floor = remainingBytes / (speedNow * RATE_TREND_MAX_GROWTH);
    return Math.min(steady, Math.max(ramped, floor));
  }

  /**
   * How fast media can be carried to the player, as a multiple of realtime:
   * the measured data-channel throughput divided by the stream's own bitrate.
   * Null while either is unknown.
   *
   * @returns {number | null}
   */
  #measuredLinkMediaRate(outputMbps) {
    const linkMbps = getEstimatedLinkMbps();
    const mediaMbps = outputMbps;
    if (!Number.isFinite(linkMbps) || linkMbps <= 0) {
      return null;
    }
    if (!Number.isFinite(mediaMbps) || mediaMbps <= 0) {
      return null;
    }
    return linkMbps / mediaMbps;
  }

  /**
   * Keep the shown number from ever increasing during one wait.
   *
   * Each estimate is compared with the previous one reduced by the time that
   * has elapsed since it was shown — the promise implied by that previous
   * number. The smaller of the two wins, so the figure is a countdown. An
   * estimate is allowed to be revised UP only after {@link #resetEtaFloor}, and
   * only real events call that.
   *
   * @param {number | null} etaSeconds
   * @returns {number | null}
   */
  #applyMonotonicEta(etaSeconds) {
    if (etaSeconds === null || !Number.isFinite(etaSeconds)) {
      return etaSeconds;
    }
    const now = Date.now();
    if (this.#etaPromise !== null) {
      const elapsed = (now - this.#etaPromiseAt) / 1000;
      const promised = Math.max(0, this.#etaPromise - elapsed);
      etaSeconds = Math.min(etaSeconds, promised);
    }
    this.#etaPromise = etaSeconds;
    this.#etaPromiseAt = now;
    return etaSeconds;
  }

  #resetEtaFloor() {
    this.#etaPromise = null;
    this.#etaPromiseAt = 0;
  }

  /**
   * Parse an ffmpeg speed string like "3.24x" into a numeric multiplier.
   *
   * @param {string} speed
   * @returns {number} The multiplier, or NaN when not parseable.
   */
  #parseSpeedMultiplier(speed) {
    if (typeof speed !== "string") {
      return NaN;
    }
    const match = speed.match(/([\d.]+)\s*x/i);
    return match ? Number(match[1]) : NaN;
  }

  /**
   * Every encoder run still going, one entry each.
   *
   * One today. Several once quality can be switched without interrupting
   * playback — and then each needs its own line, because runs sharing the same
   * cores slow one another down and a single averaged figure would hide the one
   * thing worth seeing.
   *
   * @param {object | null} progress
   * @param {{ cushionRemainingSeconds: number | null }} unified
   * @returns {Array<import("../../domain/waiting-text.js").EncodingRun>}
   */
  #describeEncodingRuns(progress, unified) {
    if (!this.#encodingTracks.video && !this.#encodingTracks.audio) {
      return [];
    }
    const speed = typeof progress?.speed === "string" ? Number.parseFloat(progress.speed) : Number.NaN;
    return [{
      video: this.#encodingTracks.video,
      audio: this.#encodingTracks.audio,
      height: typeof progress?.height === "number" && progress.height > 0 ? progress.height : undefined,
      remainingSeconds: unified.cushionRemainingSeconds ?? undefined,
      speedRealtime: Number.isFinite(speed) && speed > 0 ? speed : undefined
    }];
  }

  /**
   * Score every estimate of the wait that has just ended against what actually
   * happened, and write the result to the log.
   *
   * An estimate made `N` seconds before the picture started should have said
   * `N`. The error is signed on purpose: negative means the figure was
   * optimistic, which is the failure the viewer notices, because it promises a
   * start that does not come. The first estimate and the worst one are named
   * with the terms that produced them, so the term at fault is identifiable
   * without replaying the session.
   *
   * @returns {void}
   */
  #reportEtaAccuracy() {
    const samples = this.#etaSamples;
    this.#etaSamples = [];
    if (samples.length === 0) {
      return;
    }
    const endedAt = Date.now();
    const scored = samples.map((sample) => ({
      ...sample,
      actual: (endedAt - sample.atMs) / 1000
    })).map((sample) => ({ ...sample, error: sample.predicted - sample.actual }));
    const worst = scored.reduce((a, b) => (Math.abs(b.error) > Math.abs(a.error) ? b : a));
    const errors = scored.map((sample) => Math.abs(sample.error)).sort((a, b) => a - b);
    const median = errors[Math.floor(errors.length / 2)];
    const first = scored[0];
    this.#logEvt(
      `[eta-accuracy] wait=${((endedAt - first.atMs) / 1000).toFixed(1)}s samples=${scored.length} ` +
      `medianErr=${median.toFixed(1)}s ` +
      `first: said=${first.predicted.toFixed(1)}s was=${first.actual.toFixed(1)}s err=${first.error.toFixed(1)}s [${first.terms}] ` +
      `worst: said=${worst.predicted.toFixed(1)}s was=${worst.actual.toFixed(1)}s err=${worst.error.toFixed(1)}s [${worst.terms}]`
    );
  }

  /**
   * How much media the player needs before it starts — the median of what it
   * actually needed the last few times, or one segment before any such
   * measurement exists. No player starts on less than one segment, so that is a
   * property of the playlist rather than a value chosen to make numbers fit.
   *
   * @returns {number}
   */
  #requiredBufferSeconds() {
    if (this.#playbackStartBuffers.length === 0) {
      return SEGMENT_DURATION_SECONDS;
    }
    const sorted = [...this.#playbackStartBuffers].sort((left, right) => left - right);
    return Math.max(SEGMENT_DURATION_SECONDS, sorted[Math.floor(sorted.length / 2)]);
  }
}
