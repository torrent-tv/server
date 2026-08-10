import { APP_EVENTS, PLAYER_EVENTS, PROXY_EVENTS, WAITING_EVENTS } from "../../shared/events.js";
import { APP_STATE, isWaiting } from "../../domain/app-state.js";
import { formatWaitingText, stepForMeasurements } from "../../domain/waiting-text.js";
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

  /**
   * Its own. Nobody hands this component a conclusion: it is given what was
   * measured and works out what that means itself. The pipeline holds a second
   * instance for its own decision about when the picture may start — same
   * class, so the two answers cannot drift apart.
   *
   * @type {WaitingModel}
   */
  #model = new WaitingModel();

  /** @type {number | null} Latest reading from the component that owns the element. */
  #bufferedAhead = null;

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
    document.addEventListener(PLAYER_EVENTS.BUFFER, this.#onBuffer);
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
   * The proxy answered. Raw figures in, this component's own conclusions out.
   *
   * @param {CustomEvent} event
   */
  #onProxyMeasured = (event) => {
    const detail = event instanceof CustomEvent ? event.detail : null;
    const downloadStats = detail?.downloadStats ?? null;
    const transcodeProgress = detail?.transcodeProgress ?? null;
    const unified = this.#model.update({
      bufferedAhead: this.#bufferedAhead ?? undefined,
      downloadStats,
      transcodeProgress
    });
    const needed = downloadStats?.resumeNeededBytes;
    const got = downloadStats?.resumeDownloadedBytes;
    const usable = transcodeProgress && transcodeProgress.state !== "failed";
    Object.assign(this.#measurements, {
      peers: downloadStats?.numPeers,
      downloadBytesPerSecond: downloadStats?.downloadSpeed,
      remainingBytes: typeof needed === "number" && typeof got === "number"
        ? Math.max(0, needed - got)
        : undefined,
      cushionPercent: usable ? unified.cushionPercent ?? undefined : undefined,
      cushionRemainingSeconds: usable ? unified.cushionRemainingSeconds ?? undefined : undefined,
      encodingRuns: usable ? this.#model.describeEncodingRuns(transcodeProgress, unified) : [],
      etaSeconds: unified.etaSeconds ?? undefined
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
    const fillRate = event instanceof CustomEvent ? event.detail?.fillRate : null;
    if (typeof ahead !== "number") {
      return;
    }
    this.#bufferedAhead = ahead;
    this.#measurements.bufferedSeconds = ahead;
    // Recomputed here too, not only when the proxy answers. The cushion and the
    // estimate are measured AT THE BUFFER, so a new reading is exactly the
    // moment they change; waiting for the next poll left the one figure the
    // viewer wants a second and a half stale, and left it missing altogether
    // until the first poll after a reading ever arrived.
    const unified = this.#model.update({
      bufferedAhead: ahead,
      fillRate: typeof fillRate === "number" ? fillRate : undefined
    });
    this.#measurements.cushionPercent = unified.cushionPercent ?? undefined;
    this.#measurements.cushionRemainingSeconds = unified.cushionRemainingSeconds ?? undefined;
    this.#measurements.etaSeconds = unified.etaSeconds ?? undefined;
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
    if (typeof state !== "string" || isWaiting(state) || state === APP_STATE.PAUSED) {
      return;
    }
    this.#measurements = {};
    this.#pipelineStep = "";
    this.#render();
  };

  /**
   * What the pipeline said if it said anything, and what the numbers say
   * otherwise. A named step always wins: it knows things no measurement does.
   *
   * @returns {void}
   */
  #applyStep() {
    const step = this.#pipelineStep.length > 0
      ? this.#pipelineStep
      : stepForMeasurements(this.#measurements);
    if (typeof step === "string" && step.length > 0) {
      this.#measurements.stage = step;
    } else {
      delete this.#measurements.stage;
    }
  }

  #render() {
    const text = formatWaitingText(this.#measurements);
    // `replaceChildren` rather than `textContent`: it removes whatever is there
    // first, whoever put it there, so the node cannot accumulate.
    this.#text.replaceChildren(text);
    this.#text.style.visibility = text.length > 0 ? "visible" : "hidden";
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
