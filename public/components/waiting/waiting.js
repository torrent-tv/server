import { APP_EVENTS, LOADING_EVENTS, PLAYER_EVENTS, PROXY_EVENTS, WAITING_EVENTS } from "../../shared/events.js";
import { APP_STATE, isWaiting } from "../../domain/app-state.js";
import { formatWaitingText } from "../../domain/waiting-text.js";
import { WaitingModel } from "../../domain/waiting-model.js";

/**
 * The waiting overlay's text.
 *
 * **Nobody tells this component what to display.** It subscribes to facts —
 * measurements as they are taken, and the name of the step the pipeline is on —
 * accumulates them, and rebuilds its own text from them. That is the whole
 * design, and it is not a matter of taste: the previous shape, where callers
 * handed it finished text, produced the same defect three times. A caller took
 * what the overlay had just rendered and passed it back as the step; every
 * later render appended its own rows to that; the line grew by two or three
 * rows a pass until it ran off the screen. Measured 2026-08-09 at 53 rows.
 *
 * Removing the render's return value would have stopped that one path. Removing
 * the ABILITY to hand it text stops the class: there is no longer any way to
 * say "display this". There is only "this was measured" and "this step began",
 * and what those add up to on screen is this component's business alone.
 *
 * The words themselves are made by `domain/waiting-text.js`, which is pure and
 * tested; this class is the subscription and the element, nothing more.
 */
export class WaitingOverlay {
  static SELECTOR = {
    text: "#player__buffering-peers"
  };

  #text;

  /**
   * Everything measured so far about the current wait. Fields arrive
   * independently and at different rates — peers every second and a half, the
   * cushion four times a second — so they accumulate here rather than each
   * event having to carry the whole picture.
   *
   * @type {import("../../domain/waiting-text.js").WaitingMeasurements}
   */
  #measurements = {};

  /** Presents the proxy's forecast; it does not make a playback decision. @type {WaitingModel} */
  #model = new WaitingModel();

  /** @type {number | null} Latest reading from the component that owns the element. */
  #bufferedAhead = null;
  #timer = null;
  #waitSequence = 0;
  #waitStartedAt = null;
  #waitFileIndex = null;
  #wasWaiting = false;
  #awaitingFirstPresentedFrame = false;
  #lastRenderedText = null;


  /**
   * The step the pipeline named, if it named one. A seek runs no pipeline step,
   * so on a seek this stays empty and the step is worked out from the numbers
   * instead — otherwise three different waits (pieces, the encoder being moved,
   * the first segment out of it) look identical on screen.
   *
   * @type {string}
   */
  #pipelineStep = "";

  constructor() {
    this.#text = document.querySelector(WaitingOverlay.SELECTOR.text);
    if (!this.#text) {
      return;
    }
    document.addEventListener(PROXY_EVENTS.MEASURED, this.#onProxyMeasured);
    document.addEventListener(LOADING_EVENTS.FILE_CHOSEN, this.#onFileChosen);
    document.addEventListener(PLAYER_EVENTS.BUFFER, this.#onBuffer);
    document.addEventListener(PLAYER_EVENTS.FIRST_FRAME, this.#onFirstFrame);
    document.addEventListener(WAITING_EVENTS.STEP, this.#onStep);
    document.addEventListener(APP_EVENTS.STATE_CHANGED, this.#onStateChanged);
  }

  /**
   * New measurements. Only the fields present are touched; a field explicitly
   * set to `undefined` is forgotten, which is how a measurement that stops
   * applying (the download window closing) leaves the screen.
   *
   * @param {CustomEvent} event
   */
  /**
   * The proxy answered with its forecast and the current source measurements.
   *
   * @param {CustomEvent} event
   */
  #onProxyMeasured = (event) => {
    const detail = event instanceof CustomEvent ? event.detail : null;
    const downloadStats = detail?.downloadStats ?? null;
    const transcodeProgress = detail?.transcodeProgress ?? null;
    const readiness = detail?.playbackReadiness;
    const hasCurrentWaitEstimate = this.#awaitingFirstPresentedFrame && downloadStats &&
      Object.hasOwn(downloadStats, "waitEstimate");
    const earlyWaitEstimate = this.#awaitingFirstPresentedFrame && downloadStats?.waitEstimate &&
      typeof downloadStats.waitEstimate === "object"
      ? { ...downloadStats.waitEstimate,
        ageMs: this.#waitStartedAt === null ? downloadStats.waitEstimate.ageMs ?? 0 :
          Math.max(0, performance.now() - this.#waitStartedAt) }
      : downloadStats?.waitEstimate;
    const unified = this.#model.update({
      ...(hasCurrentWaitEstimate ? { waitEstimate: earlyWaitEstimate } : {}),
      ...(detail && Object.hasOwn(detail, "playbackReadiness") ? { playbackReadiness: readiness } : {}),
      bufferedAhead: this.#bufferedAhead ?? undefined
    });
    const needed = downloadStats?.resumeNeededBytes;
    const got = downloadStats?.resumeDownloadedBytes;
    const usable = transcodeProgress && transcodeProgress.state !== "failed";
    // Download and processing can be active concurrently.
    const downloading = typeof needed === "number" && typeof got === "number" ? got < needed : !usable;
    Object.assign(this.#measurements, {
      peers: downloading ? downloadStats?.numPeers : undefined,
      seeders: downloading ? downloadStats?.trackerSeeders : undefined,
      neededBytes: downloading ? needed : undefined,
      downloadedBytes: downloading ? got : undefined,
      operations: detail && Object.hasOwn(detail, "playbackReadiness") ? readiness?.operations : this.#measurements.operations,
      downloadBytesPerSecond: downloading ? downloadStats?.downloadSpeed : undefined,
      remainingBytes: downloading && typeof needed === "number" && typeof got === "number"
        ? Math.max(0, needed - got)
        : undefined,
      cushionPercent: usable ? unified.cushionPercent ?? undefined : undefined,
      cushionRemainingSeconds: usable ? unified.cushionRemainingSeconds ?? undefined : undefined,
      etaSeconds: unified.etaSeconds ?? undefined,
      readinessReason: unified.reason,
      readinessUnavailable: usable && readiness !== undefined && readiness !== null &&
        readiness.version !== 1
    });
    this.#applyStep();
    this.#render();
  };

  /**
   * The player measured its own element.
   *
   * @param {CustomEvent} event
   */
  #onBuffer = (event) => {
    const ahead = event instanceof CustomEvent ? event.detail?.bufferedAhead : null;
    if (typeof ahead !== "number") {
      return;
    }
    this.#bufferedAhead = ahead;
    this.#measurements.bufferedSeconds = ahead;
    const unified = this.#model.update({ bufferedAhead: ahead });
    this.#measurements.cushionPercent = unified.cushionPercent ?? undefined;
    this.#measurements.cushionRemainingSeconds = unified.cushionRemainingSeconds ?? undefined;
    this.#measurements.etaSeconds = unified.etaSeconds ?? undefined;
    this.#measurements.readinessReason = unified.reason;
    this.#applyStep();
    this.#render();
  };

  /**
   * The pipeline moved to a named step.
   *
   * @param {CustomEvent} event
   */
  #onStep = (event) => {
    const value = event instanceof CustomEvent ? event.detail?.value : "";
    this.#pipelineStep = typeof value === "string" ? value : "";
    this.#applyStep();
    this.#render();
  };

  /**
   * A wait that has ended takes its measurements with it. Otherwise the next
   * one opens showing the last one's peers and the last one's estimate for a
   * second and a half, until its own first poll answers.
   *
   * @param {CustomEvent} event
   */
  #onStateChanged = (event) => {
    const state = event instanceof CustomEvent ? event.detail?.state : "";
    const waiting = isWaiting(state);
    if (waiting && !this.#wasWaiting && !this.#awaitingFirstPresentedFrame) {
      this.#waitSequence += 1;
      this.#waitStartedAt = performance.now();
      this.#waitFileIndex = null;
      this.#awaitingFirstPresentedFrame = true;
      this.#lastRenderedText = null;
      console.debug(`[wait-start] wait=${this.#waitSequence} startedAt=${this.#waitStartedAt.toFixed(3)}ms state=${state}`);
    }
    if (!waiting && state !== APP_STATE.ADVANCING) {
      this.#awaitingFirstPresentedFrame = false;
      this.#waitFileIndex = null;
    }
    this.#wasWaiting = waiting;
    if (waiting && this.#timer === null) {
      // Spend at most four percent of the current wait on a stale displayed
      // value, leaving room for the duration formatter's rounding.
      const refresh = () => {
        if (this.#timer === null) return;
        const estimate = this.#model.update({}).etaSeconds ?? undefined;
        this.#measurements.etaSeconds = estimate;
        this.#render();
        const delay = typeof estimate === "number" && estimate > 0
          ? Math.min(100, Math.max(1, estimate * 40)) : 100;
        this.#timer = setTimeout(refresh, delay);
      };
      this.#timer = setTimeout(refresh, 100);
    } else if (!isWaiting(state) && this.#timer !== null) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    if (typeof state !== "string" || isWaiting(state) || state === APP_STATE.PAUSED) {
      return;
    }
    this.#model.reset();
    this.#bufferedAhead = null;
    this.#measurements = {};
    this.#pipelineStep = "";
    this.#render();
  };

  /** @param {CustomEvent} event */
  #onFileChosen = (event) => {
    const detail = event instanceof CustomEvent ? event.detail : null;
    const fileIndex = Number.isSafeInteger(detail?.fileIndex) ? detail.fileIndex : null;
    if (detail?.originalOpen !== true && this.#awaitingFirstPresentedFrame && this.#waitFileIndex === fileIndex) {
      return;
    }
    this.#model.reset();
    this.#bufferedAhead = null;
    this.#measurements = {};
    this.#pipelineStep = "";
    this.#waitSequence += 1;
    this.#waitStartedAt = Number.isFinite(detail?.startedAt) ? detail.startedAt : performance.now();
    this.#waitFileIndex = fileIndex;
    this.#awaitingFirstPresentedFrame = true;
    this.#lastRenderedText = null;
    console.debug(`[wait-start] wait=${this.#waitSequence} startedAt=${this.#waitStartedAt.toFixed(3)}ms ` +
      `fileIndex=${fileIndex ?? "-"}${detail?.originalOpen === true ? " originalOpen=true" : ""}`);
  };

  #onFirstFrame = (event) => {
    const waitSequence = event instanceof CustomEvent ? event.detail?.waitSequence : null;
    if (waitSequence === this.#waitSequence) {
      this.#awaitingFirstPresentedFrame = false;
      this.#waitStartedAt = null;
      this.#waitFileIndex = null;
    }
  };

  /**
   * The pipeline step, or the proxy readiness model's state.
   *
   * @returns {void}
   */
  #applyStep() {
    const step = this.#pipelineStep.length > 0
      ? this.#pipelineStep
      : undefined;
    if (typeof step === "string" && step.length > 0) {
      this.#measurements.stage = step;
    } else {
      delete this.#measurements.stage;
    }
  }

  #render() {
    const text = formatWaitingText(this.#measurements);
    if (text === this.#lastRenderedText) {
      return;
    }
    // `replaceChildren` rather than `textContent`: it removes whatever is there
    // first, whoever put it there, so the node cannot accumulate.
    this.#text.replaceChildren(text);
    this.#text.style.visibility = text.length > 0 ? "visible" : "hidden";
    this.#lastRenderedText = text;
    const estimate = this.#measurements.etaSeconds;
    if (typeof estimate === "number" && Number.isFinite(estimate)) {
      console.debug(`[wait-estimate] wait=${this.#waitSequence} renderedAt=${performance.now().toFixed(3)}ms ` +
        `elapsedMs=${this.#waitStartedAt === null ? "?" : (performance.now() - this.#waitStartedAt).toFixed(3)} ` +
        `seconds=${estimate.toFixed(6)} reason=${this.#measurements.readinessReason ?? "unknown"} ` +
        `label=${JSON.stringify(text.split("\n").at(-1))}`);
    }
  }
}

function bootstrapWaitingOverlay() {
  new WaitingOverlay();
}

if (document.readyState !== "loading") {
  bootstrapWaitingOverlay();
} else {
  document.addEventListener("DOMContentLoaded", bootstrapWaitingOverlay, { once: true });
}
