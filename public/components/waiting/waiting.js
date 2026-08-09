import { APP_EVENTS, WAITING_EVENTS } from "../../shared/events.js";
import { APP_STATE, isWaiting } from "../../domain/app-state.js";
import { formatWaitingText } from "../../domain/waiting-text.js";

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

  constructor() {
    this.#text = document.querySelector(WaitingOverlay.SELECTOR.text);
    if (!this.#text) {
      return;
    }
    document.addEventListener(WAITING_EVENTS.MEASURED, this.#onMeasured);
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
  #onMeasured = (event) => {
    const detail = event instanceof CustomEvent ? event.detail : null;
    if (!detail || typeof detail !== "object") {
      return;
    }
    for (const [key, value] of Object.entries(detail)) {
      if (value === undefined) {
        delete this.#measurements[key];
      } else {
        this.#measurements[key] = value;
      }
    }
    this.#render();
  };

  /**
   * The pipeline moved to a named step.
   *
   * @param {CustomEvent} event
   */
  #onStep = (event) => {
    const value = event instanceof CustomEvent ? event.detail?.value : "";
    this.#measurements.stage = typeof value === "string" && value.length > 0 ? value : undefined;
    if (this.#measurements.stage === undefined) {
      delete this.#measurements.stage;
    }
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
    this.#render();
  };

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
