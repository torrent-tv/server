/**
 * @file One fetch per question, however many browsers ask it at once.
 *
 * Two lifetimes, kept apart because they belong to different people:
 *
 *  - a FETCH belongs to the question. It runs to its own deadline and its
 *    answer goes to the cache, so a browser that gives up does not cancel what
 *    another browser — or the same one a second later — is waiting for;
 *  - a WAIT belongs to one browser's request. It ends at that request's
 *    deadline or when the request is cancelled, and ending it detaches that one
 *    waiter and nothing else.
 *
 * The number of waiters is bounded on its own: many browsers may join one
 * fetch, so the provider-side queue limit says nothing about how many requests
 * are held open here.
 */

import { MetadataUnavailableError } from "./RequestGate.js";

export class SharedFetches {
  /** @type {Map<string, Promise<unknown>>} */
  #flights = new Map();

  #waiters = 0;

  /** @type {number} */
  #waiterLimit;

  /**
   * @param {object} params
   * @param {number} params.waiterLimit - Requests that may wait at once, over all fetches.
   */
  constructor({ waiterLimit }) {
    this.#waiterLimit = waiterLimit;
  }

  /**
   * Wait for the answer to `key`, starting the fetch if nobody has.
   *
   * @template T
   * @param {string} key
   * @param {() => Promise<T>} start - Runs the fetch; bounded by its own deadline.
   * @param {{ deadlineAt: number, signal?: AbortSignal, now?: () => number }} wait
   * @returns {Promise<T>}
   */
  join(key, start, { deadlineAt, signal, now = Date.now }) {
    if (this.#waiters >= this.#waiterLimit) {
      return Promise.reject(new MetadataUnavailableError("too many requests waiting"));
    }
    let flight = this.#flights.get(key);
    if (!flight) {
      flight = Promise.resolve().then(start);
      this.#flights.set(key, flight);
      const forget = () => {
        if (this.#flights.get(key) === flight) {
          this.#flights.delete(key);
        }
      };
      flight.then(forget, forget);
    }
    this.#waiters += 1;
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (action) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        this.#waiters -= 1;
        action();
      };
      const onAbort = () => finish(() => reject(new MetadataUnavailableError("the request was cancelled")));
      const timer = setTimeout(
        () => finish(() => reject(new MetadataUnavailableError("the deadline passed"))),
        Math.max(0, deadlineAt - now())
      );
      timer.unref?.();
      if (signal?.aborted) {
        onAbort();
        return;
      }
      signal?.addEventListener("abort", onAbort, { once: true });
      flight.then(
        (value) => finish(() => resolve(value)),
        (error) => finish(() => reject(error))
      );
    });
  }

  /**
   * @returns {{ fetches: number, waiters: number }}
   */
  stats() {
    return { fetches: this.#flights.size, waiters: this.#waiters };
  }
}
