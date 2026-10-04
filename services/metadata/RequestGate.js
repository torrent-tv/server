/**
 * @file The one door every request to a metadata provider goes through.
 *
 * A provider's limits are its own and can change without notice — TMDB states
 * only that its upper bound "sits somewhere in the 40 requests per second
 * range" and asks that a `429` be honoured. So the load this server puts on it
 * is bounded here, by stated limits, whatever arrives from browsers:
 *
 *  - at most `concurrency` requests in flight;
 *  - starts spaced so that no more than `perSecond` begin in any second;
 *  - at most `queueLimit` waiting — beyond that a request is refused at once
 *    rather than queued, so a burst of distinct titles cannot build a backlog;
 *  - a request whose deadline passes while it waits is dropped unstarted;
 *  - while the provider has asked us to pause, nothing is queued and nothing
 *    starts: everything waiting is refused, and so is everything new until the
 *    pause ends.
 *
 * A refusal is an error of its own type so that callers can tell "the provider
 * is not available now" from "the provider answered that nothing exists" —
 * only the second may ever be remembered.
 */

/** Refused by the gate or the provider: nothing was learned about the work. */
export class MetadataUnavailableError extends Error {
  /**
   * @param {string} reason
   */
  constructor(reason) {
    super(`metadata unavailable: ${reason}`);
    this.name = "MetadataUnavailableError";
    this.reason = reason;
  }
}

export class RequestGate {
  /** @type {number} */
  #concurrency;

  /** Milliseconds between two starts. @type {number} */
  #spacingMs;

  /** @type {number} */
  #queueLimit;

  /** @type {() => number} */
  #now;

  #active = 0;

  /** @type {Array<{ task: () => Promise<unknown>, resolve: (value: unknown) => void, reject: (error: unknown) => void, deadlineAt: number }>} */
  #queue = [];

  #nextStartAt = 0;

  #pausedUntil = 0;

  /** @type {ReturnType<typeof setTimeout> | null} */
  #timer = null;

  /**
   * @param {object} params
   * @param {number} params.concurrency
   * @param {number} params.perSecond - `Infinity` for no spacing.
   * @param {number} params.queueLimit
   * @param {() => number} [params.now]
   */
  constructor({ concurrency, perSecond, queueLimit, now = Date.now }) {
    this.#concurrency = concurrency;
    this.#spacingMs = Number.isFinite(perSecond) && perSecond > 0 ? 1000 / perSecond : 0;
    this.#queueLimit = queueLimit;
    this.#now = now;
  }

  /**
   * When the provider's pause ends, or 0 when it has asked for none.
   *
   * @returns {number}
   */
  get pausedUntil() {
    return this.#pausedUntil > this.#now() ? this.#pausedUntil : 0;
  }

  /**
   * Run one request through the gate.
   *
   * @template T
   * @param {() => Promise<T>} task
   * @param {{ deadlineAt: number, priority?: number }} options
   * @returns {Promise<T>}
   */
  run(task, { deadlineAt, priority = 0 }) {
    if (this.pausedUntil > 0) {
      return Promise.reject(new MetadataUnavailableError("the provider asked us to pause"));
    }
    if (this.#queue.length >= this.#queueLimit) {
      return Promise.reject(new MetadataUnavailableError("too many requests waiting"));
    }
    return new Promise((resolve, reject) => {
      const item = { task, resolve, reject, deadlineAt, priority };
      const before = this.#queue.findIndex(waiting => (waiting.priority ?? 0) < priority);
      if (before < 0) this.#queue.push(item);
      else this.#queue.splice(before, 0, item);
      this.#pump();
    });
  }

  /**
   * The provider answered `429`: refuse everything waiting and start nothing
   * until `untilMs`.
   *
   * @param {number} untilMs
   */
  pause(untilMs) {
    this.#pausedUntil = Math.max(this.#pausedUntil, untilMs);
    const waiting = this.#queue.splice(0);
    for (const item of waiting) {
      item.reject(new MetadataUnavailableError("the provider asked us to pause"));
    }
  }

  #pump() {
    if (this.#timer !== null) {
      return;
    }
    while (this.#active < this.#concurrency && this.#queue.length > 0) {
      const now = this.#now();
      if (now < this.#nextStartAt) {
        this.#timer = setTimeout(() => {
          this.#timer = null;
          this.#pump();
        }, this.#nextStartAt - now);
        this.#timer.unref?.();
        return;
      }
      const item = this.#queue.shift();
      if (item.deadlineAt <= now) {
        item.reject(new MetadataUnavailableError("the deadline passed while waiting"));
        continue;
      }
      this.#active += 1;
      this.#nextStartAt = Math.max(now, this.#nextStartAt) + this.#spacingMs;
      Promise.resolve()
        .then(item.task)
        .then(item.resolve, item.reject)
        .finally(() => {
          this.#active -= 1;
          this.#pump();
        });
    }
  }
}
