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

/** The cushion to bank when no fill rate has been measured yet. */
const PREBUFFER_TARGET_SECONDS = 15;
/** Never bank less than this, however healthy the surplus looks. */
const PREBUFFER_MIN_SECONDS = 6;
/** Never bank more than this, however thin the surplus. */
const PREBUFFER_MAX_SECONDS = 25;
/** Seconds of cushion per unit of surplus over realtime. */
const PREBUFFER_BASE_SECONDS = 12;

/** How long the download-rate trend is worth extrapolating from. */
const RATE_TREND_WINDOW_MS = 6_000;
/** The gate's own early-start thresholds. Must stay equal to the player's. */
const GATE_HEALTHY_FILL_RATE = 1.35;
const GATE_HEALTHY_AHEAD_SECONDS = 10;
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

  /**
   * Seconds of media gained per second of wall clock, measured at the buffer by
   * whoever owns the element.
   *
   * This is the END-TO-END rate — torrent, encoder, data channel and decoding,
   * all at once — so it is the only term that prices in every bottleneck
   * together, including ones no single stage can see. It was being delivered on
   * every reading and thrown away: the model declared it, logged it, and never
   * assigned it, so `fillRate=n/a` stood in every line of the diagnostic while
   * the buffer visibly moved (measured 2026-08-09: 35.99 to 35.17 over four
   * readings, rate never once computed). Every estimate the viewer was shown
   * therefore rested on the weaker terms, which is why none of them held.
   *
   * @type {number | null}
   */
  #fillRate = null;

  /** @type {Array<{ atMs: number, rate: number }>} Recent fill-rate readings. */
  #fillRateSamples = [];
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
  /** @type {object | null} The proxy's last word about the torrent. */
  #downloadStats = null;
  /** @type {object | null} The proxy's last word about the encode. */
  #transcodeProgress = null;
  /** @type {{ video: boolean, audio: boolean }} */
  #encodingTracks = { video: false, audio: false };
  /** @type {boolean} Whether the step on screen came from the pipeline. */
  #stageFromPipeline = false;

  /**
   * When each stage of THIS wait was first observed to have completed.
   *
   * The point is to make a miss name the term that caused it. "Said 4 s, took
   * 47" says nothing about where the 43 went; "predicted 4 s to produce a first
   * segment, it took 7.5" is a defect with an address. Every stage below is
   * something the facts already report — the estimate predicts each one, so
   * each one can be scored on its own, and the viewer still sees a single
   * total.
   *
   * @type {{ startedAt: number, sessionAt: number | null, producedAt: number | null, fillingAt: number | null }}
   */
  #stageMarks = { startedAt: Date.now(), sessionAt: null, producedAt: null, fillingAt: null };

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
    if (typeof facts.fillRate === "number" && Number.isFinite(facts.fillRate)) {
      this.#fillRate = facts.fillRate;
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
    // Kept between calls, because the callers do not all know everything. The
    // buffer is read four times a second by the component that owns the
    // element; the proxy answers about once every second and a half. A reading
    // that arrives on its own must not blank what the proxy last said — it did,
    // and the diagnostic line then alternated `proxyProcessed=4208.333` with
    // `proxyProcessed=null` and `13823KB/s` with `0KB/s`, every other line, so
    // half of every session's evidence described a state that never existed.
    if (facts.downloadStats) {
      this.#downloadStats = facts.downloadStats;
    }
    if (facts.transcodeProgress) {
      this.#transcodeProgress = facts.transcodeProgress;
    }
    return this.#computeUnifiedEta(this.#downloadStats, this.#transcodeProgress);
  }

  /** Every encoder run still going, for the overlay to list one line each. */
  describeEncodingRuns(transcodeProgress, unified) {
    return this.#describeEncodingRuns(transcodeProgress, unified);
  }

  /**
   * How much cushion the picture needs before it may start — THE figure the
   * pre-buffer gate releases on, so the estimate and the gate cannot disagree.
   *
   * They did, and it is what made the estimate useless at the only moment
   * anyone reads it. The model asked for one segment (4 s) while the gate held
   * out for fifteen, so the model announced "ready, nothing to wait for" and
   * the picture stayed still for another six to twelve seconds. Measured
   * 2026-08-09: `said=0.0s was=11.9s` and `said=0.0s was=5.6s`, and in the worst
   * case an estimate of 0.7 s against a wait of 54.5 s, because with the cushion
   * believed met the fill term was left out of the sum altogether.
   *
   * A cushion that fills fast needs to be smaller: the surplus above realtime is
   * what keeps it from draining, so the greater the surplus the less has to be
   * banked before starting. With no surplus at all, bank the maximum.
   *
   * @returns {number} Seconds.
   */
  requiredBufferSeconds() {
    const fillRate = this.#fillRate;
    if (!Number.isFinite(fillRate)) {
      return PREBUFFER_TARGET_SECONDS;
    }
    const margin = fillRate - 1;
    if (margin <= 0) {
      return PREBUFFER_MAX_SECONDS;
    }
    return Math.min(
      PREBUFFER_MAX_SECONDS,
      Math.max(PREBUFFER_MIN_SECONDS, PREBUFFER_BASE_SECONDS / margin)
    );
  }

  /** Score the estimates of the wait that just ended. */
  reportEtaAccuracy() {
    this.#reportEtaAccuracy();
  }

  /** A wait that has ended takes its history with it. */
  reset() {
    // The buffer reading goes with it. A new wait has measured nothing yet, and
    // keeping the last one made the first render of the next wait state a
    // cushion that belonged to the wait before it.
    this.#bufferedAhead = null;
    this.#downloadRateSamples = [];
    this.#stageMarks = { startedAt: Date.now(), sessionAt: null, producedAt: null, fillingAt: null };
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
    let fillRate = this.#fillRate;
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

    // Stage boundaries of the wait actually happening, recorded once each.
    const nowMs = Date.now();
    if (this.#stageMarks.sessionAt === null && processedSeconds !== null) {
      this.#stageMarks.sessionAt = nowMs;
    }
    if (this.#stageMarks.producedAt === null && producedSinceResume !== null && producedSinceResume > 0) {
      this.#stageMarks.producedAt = nowMs;
    }
    if (this.#stageMarks.fillingAt === null && typeof bufferedAhead === "number" && bufferedAhead > 0) {
      this.#stageMarks.fillingAt = nowMs;
    }

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
    // What the viewer waits for is PLAYBACK STARTING, and that is not the same
    // event as the cushion filling. The gate starts early when the buffer holds
    // a healthy amount AND the rate has sustained a surplus — so on a healthy
    // link the picture begins at ten seconds, not at the full target.
    //
    // Estimating the full target regardless is where the large overestimates
    // came from: measured 2026-08-10, three waits promised 25.0, 20.2 and 24.8
    // seconds and ended after 7.1, 1.7 and 0.6. The figure never moved during
    // any of them either, which is honest arithmetic on an unchanging input and
    // still the wrong answer — it was answering a question nobody had asked.
    const requiredBuffer = this.#gateTargetSeconds();
    // Nothing measured is NOT the same as measured and empty, and both used to
    // answer 0%. The difference shows: before the player has produced a single
    // reading, "Buffering — 0%" is a figure nobody took, printed as though it
    // had been. Not knowing is said by saying nothing.
    if (bufferedAhead === null) {
      cushionRemainingSeconds = requiredBuffer;
      cushionPercent = null;
    } else {
      cushionRemainingSeconds = Math.max(0, requiredBuffer - bufferedAhead);
      cushionPercent = Math.max(0, Math.min(100, (bufferedAhead / requiredBuffer) * 100));
    }
    if (cushionPercent === null) {
      // Nothing measured about the cushion means nothing may be said about how
      // long it will take to fill. Reported as zero, it read "0 seconds until
      // playback" over a picture that had not started and was not about to —
      // measured 2026-08-09 with 29 peers and 5.9 MB/s, so the wait looked
      // finished while the only figure that ends it had never been taken.
      return { etaSeconds: null, cushionPercent: null, cushionRemainingSeconds, encodeSpeedText: null };
    }
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
      // How fast media is actually arriving. The buffer's own fill rate first,
      // because it is the end result of the whole chain and prices every
      // bottleneck at once; then the slower of what the encoder reports and what
      // the link can carry.
      const linkRate = this.#measuredLinkMediaRate(
        transcodeProgress && typeof transcodeProgress.outputMbps === "number"
          ? transcodeProgress.outputMbps
          : null
      );
      // The slowest rate seen recently, not the latest one. Dividing a
      // shortfall by the instantaneous rate assumes that rate will hold, and it
      // does not: measured 2026-08-10, a cushion 1.3 s short at 2.04x was
      // promised in 1.3 s and took 34.6, because the rate collapsed immediately
      // after. A wait is governed by its worst stretch, not its best, so the
      // honest divisor is the floor of what has actually been observed.
      this.#recordFillRate(this.#fillRate);
      const measured = this.#conservativeFillRate();
      const rates = [encodeSpeed, linkRate].filter((rate) => typeof rate === "number" && rate > 0);
      const arrivalRate = measured ?? (rates.length > 0 ? Math.min(...rates) : null);

      if (measured !== null) {
        // MEASURED at the buffer, which is the far end of the whole chain: the
        // torrent, the encoder, the data channel and the browser's own decoding
        // are all already inside this one number. Adding the stage terms on top
        // of it adds a part to a whole — measured 2026-08-09, that produced an
        // estimate of 28.7 s for a wait that lasted 1.6 s. So when it exists it
        // is the entire answer, and the stage terms are kept only as evidence
        // of where the time is expected to go.
        const fillSeconds = cushionRemainingSeconds / measured;
        terms.push(`stages-superseded=${total.toFixed(1)}`);
        total = fillSeconds;
        terms.push(`fill=${fillSeconds.toFixed(1)}@${measured.toFixed(2)}x-measured`);
      } else if (arrivalRate !== null) {
        // Nothing measured end to end yet; the slower of what the encoder
        // reports and what the link carries is the best available, and the
        // stage terms above are still needed because this rate describes only
        // the stage it came from.
        const fillSeconds = cushionRemainingSeconds / arrivalRate;
        total += fillSeconds;
        terms.push(`fill=${fillSeconds.toFixed(1)}@${arrivalRate.toFixed(2)}x-stage`);
      } else {
        // NOTHING has been measured yet. The previous version divided by an
        // assumed 1.0 — "the pipeline is keeping up" — and produced a confident
        // small number out of nothing: measured 2026-08-09, it said 4.0 s of a
        // wait that ran 46.8 s, with a median error of 21.8 s over 164 samples.
        // Not one figure shown to the viewer was borne out.
        //
        // The honest substitute is another MEASUREMENT: how long this host has
        // historically taken to produce a first segment, which the proxy reports
        // from the median of its own recent sessions. It is not a measurement of
        // THIS wait, and it is displaced by one the moment the buffer moves —
        // but it is a fact about the machine doing the work, not an assumption
        // about it.
        const hostPrior = this.#expectedFirstSegmentSeconds;
        const fillSeconds = typeof hostPrior === "number" && hostPrior > 0
          ? hostPrior
          : cushionRemainingSeconds;
        total += fillSeconds;
        terms.push(`fill=${fillSeconds.toFixed(1)}@host-median`);
      }
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
    // No floor. A guard that capped each estimate at "the previous one minus
    // the time since" was removed in server 0.8.109 and came back with this
    // extraction. Its arithmetic ends one way: once a promise has run down to
    // zero, `min(actual, 0)` is zero for ever. Measured 2026-08-09 — the source
    // line read `fill=4.0@1.00x` while the screen read `0 seconds until
    // playback`, for the whole of a wait in which the buffer never moved. It
    // existed to hide jumps between estimate sources; there is one source now,
    // so a rise means the wait genuinely got longer, and saying so is the point.
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
  /**
   * How long each stage of the wait that just ended actually took.
   *
   * Printed beside the score so a miss points at a term rather than at the
   * total. A stage that never happened is named as such: it did not take zero
   * seconds, it was never reached, and the two mean different things when the
   * question is which prediction was wrong.
   *
   * @param {number} endedAt
   * @returns {string}
   */
  #describeStages(endedAt) {
    const { startedAt, sessionAt, producedAt, fillingAt } = this.#stageMarks;
    // Marks are not guaranteed to fall in pipeline order: after a seek the
    // buffer still holds media from the previous position, so "first bytes
    // arrived" can be observed before "the encoder produced anything". A
    // duration measured backwards through that is not a small negative number,
    // it is a stage that did not happen in this wait — and saying so is the
    // difference between a reading and a puzzle.
    const span = (from, to) => {
      if (from === null || to === null) {
        return "never";
      }
      return to < from ? "not-in-order" : `${((to - from) / 1000).toFixed(1)}s`;
    };
    return (
      `create=${span(startedAt, sessionAt)} ` +
      `first-segment=${span(sessionAt, producedAt)} ` +
      `first-bytes=${span(producedAt, fillingAt)} ` +
      `cushion=${span(fillingAt, endedAt)} ` +
      `total=${((endedAt - startedAt) / 1000).toFixed(1)}s`
    );
  }

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
      `[eta-stages] ${this.#describeStages(endedAt)}
` +
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
  /**
   * The cushion that will actually open the gate, which is what an estimate of
   * "time until playback" has to be measured against.
   *
   * Mirrors the gate's own rule: the full target, or the healthy-early amount
   * once the measured rate is comfortably above realtime. The thresholds are
   * the gate's, and they belong in one place — if they drift apart the estimate
   * silently starts describing a different event again.
   *
   * @returns {number}
   */
  #gateTargetSeconds() {
    // The PUBLIC one: the adaptive target the gate itself compares against.
    // The private namesake is the one-segment floor, and using it here made an
    // empty buffer ask for four seconds instead of fifteen.
    const target = this.requiredBufferSeconds();
    const rate = this.#fillRate;
    if (typeof rate === "number" && Number.isFinite(rate) && rate >= GATE_HEALTHY_FILL_RATE) {
      return Math.min(target, GATE_HEALTHY_AHEAD_SECONDS);
    }
    return target;
  }

  /**
   * Remember a rate reading, keeping only the recent window.
   *
   * @param {number | null} rate
   * @returns {void}
   */
  #recordFillRate(rate) {
    // Zero is recorded, not discarded: a buffer that is not filling is a
    // measurement, and the most important one. Dropping it left the last
    // optimistic reading standing while nothing arrived.
    if (typeof rate !== "number" || !Number.isFinite(rate) || rate < 0) {
      return;
    }
    const now = Date.now();
    this.#fillRateSamples.push({ atMs: now, rate });
    this.#fillRateSamples = this.#fillRateSamples.filter((each) => now - each.atMs <= RATE_TREND_WINDOW_MS);
  }

  /**
   * The slowest rate observed in the recent window, or null when none has been.
   *
   * @returns {number | null}
   */
  #conservativeFillRate() {
    if (this.#fillRateSamples.length === 0) {
      return null;
    }
    const slowest = Math.min(...this.#fillRateSamples.map((each) => each.rate));
    // A rate of zero cannot divide a shortfall — that is how 586.9 seconds
    // reached the screen. It is still the truth about the link, so it is not
    // ignored: it means this measurement can say nothing, and the estimate
    // falls through to what this host has historically taken.
    return slowest > 0 ? slowest : null;
  }

  #requiredBufferSeconds() {
    if (this.#playbackStartBuffers.length === 0) {
      return SEGMENT_DURATION_SECONDS;
    }
    const sorted = [...this.#playbackStartBuffers].sort((left, right) => left - right);
    return Math.max(SEGMENT_DURATION_SECONDS, sorted[Math.floor(sorted.length / 2)]);
  }
}
