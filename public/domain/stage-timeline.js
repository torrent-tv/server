/**
 * @file What step the wait is on, how long each one took, and how far that was
 * from what we told the viewer to expect.
 *
 * Two things were missing and they are the same thing. A seek showed a number
 * of seconds with no name for what was being waited for — pieces, an encoder
 * being moved, a first segment — so three unrelated waits looked identical. And
 * `Connecting to proxy…` covered a health poll over the tunnel, a full ICE and
 * DTLS exchange and a liveness check, which is why it could sit there for many
 * seconds with nothing to say. Neither had per-stage timing, so neither could be
 * argued about with numbers.
 *
 * A stage is opened, the viewer sees its name, and closing it writes one line:
 * how long it took, and — when something predicted it — by how much the
 * prediction was out. That difference is the only honest way to correct the
 * estimate's formula; without it any new formula is one guess replacing another.
 *
 * Pure except for the log line, so the arithmetic is testable without a browser.
 */

/**
 * One stage's record.
 *
 * @typedef {object} StageRecord
 * @property {string} name - What the viewer is told.
 * @property {number} startedAt - `performance.now()` when it opened.
 * @property {number | null} predictedMs - What we expected it to take, if
 *   anything did.
 */

/**
 * How far a measured duration was from its prediction, as a signed ratio: 0.25
 * means it took a quarter longer than promised, -0.5 means it took half as long.
 * Null when nothing predicted it.
 *
 * @param {number} actualMs
 * @param {number | null} predictedMs
 * @returns {number | null}
 */
function predictionError(actualMs, predictedMs) {
  if (typeof predictedMs !== "number" || !Number.isFinite(predictedMs) || predictedMs <= 0) {
    return null;
  }
  return (actualMs - predictedMs) / predictedMs;
}

/**
 * The stages of one wait, in order, with their durations.
 *
 * One instance per wait — a cold open or a seek. It holds no DOM and knows
 * nothing about how the name is displayed; the caller shows `name` wherever the
 * step belongs.
 */
export class StageTimeline {
  /** @type {StageRecord | null} */
  #open = null;

  /** @type {Array<{ name: string, durationMs: number, predictedMs: number | null }>} */
  #done = [];

  /** @type {(message: string) => void} */
  #log;

  /** @type {() => number} */
  #now;

  /**
   * @param {{ log?: (message: string) => void, now?: () => number }} [options]
   *   Both injectable so tests can drive the clock and read the lines.
   */
  constructor({ log, now } = {}) {
    this.#log = typeof log === "function" ? log : (message) => console.debug(message);
    this.#now = typeof now === "function" ? now : () => performance.now();
  }

  /** The stage now open, or null between stages. @returns {string | null} */
  get currentStage() {
    return this.#open === null ? null : this.#open.name;
  }

  /** Everything measured so far. @returns {ReadonlyArray<{ name: string, durationMs: number, predictedMs: number | null }>} */
  get stages() {
    return this.#done;
  }

  /** Total measured so far, in ms. @returns {number} */
  get elapsedMs() {
    return this.#done.reduce((sum, stage) => sum + stage.durationMs, 0);
  }

  /**
   * Open a stage, closing the previous one. Re-opening the stage already open is
   * a no-op, so a poll that reports the same step every 1.5 s does not chop one
   * wait into dozens of entries.
   *
   * @param {string} name
   * @param {number | null} [predictedMs] - What this stage is expected to take.
   * @returns {void}
   */
  begin(name, predictedMs = null) {
    if (this.#open !== null && this.#open.name === name) {
      return;
    }
    this.end();
    this.#open = { name, startedAt: this.#now(), predictedMs };
  }

  /**
   * Close the open stage and write its line. Safe to call with nothing open.
   *
   * @returns {void}
   */
  end() {
    if (this.#open === null) {
      return;
    }
    const durationMs = Math.max(0, this.#now() - this.#open.startedAt);
    const { name, predictedMs } = this.#open;
    this.#open = null;
    this.#done.push({ name, durationMs, predictedMs });
    const error = predictionError(durationMs, predictedMs);
    this.#log(
      `[stage] ${name} took ${Math.round(durationMs)}ms` +
      (error === null
        ? ""
        : ` (predicted ${Math.round(predictedMs)}ms, out by ${error > 0 ? "+" : ""}${Math.round(error * 100)}%)`)
    );
  }

  /**
   * Close the wait and write its summary: every stage in order with its share of
   * the total. This is the line to read when asking where a long wait went.
   *
   * @param {string} [outcome] - How it ended, for the log line.
   * @returns {void}
   */
  finish(outcome = "playing") {
    this.end();
    if (this.#done.length === 0) {
      return;
    }
    const total = this.elapsedMs;
    const parts = this.#done.map(
      (stage) => `${stage.name}=${Math.round(stage.durationMs)}ms/${Math.round((stage.durationMs / total) * 100)}%`
    );
    this.#log(`[stage] wait ended ${outcome} after ${Math.round(total)}ms: ${parts.join(" ")}`);
  }
}
