/**
 * A disk cache that only the serving instance holds open.
 *
 * Both server slots mount the same cache directory. The instance that serves
 * opens it, and the one that hands over closes it before it tells the new one
 * to serve (`services/instance-role.js`), so the SQLite file has one writer at
 * a time. While no cache is open every read misses and every write is
 * dropped; metadata and subtitles are then fetched from their providers, which
 * is what a miss means anyway.
 */
export class ExclusiveCache {
  #open;
  /** @type {{ namespace: (prefix: string) => { get: Function, set: Function }, close: () => Promise<void> } | null} */
  #current = null;
  #steps = Promise.resolve();

  /**
   * @param {() => { namespace: (prefix: string) => { get: Function, set: Function }, close: () => Promise<void> }} open
   *   Opens the underlying cache (a `DiskCache`).
   */
  constructor(open) {
    this.#open = open;
  }

  /** Open the cache unless it is open. */
  start() {
    return this.#then(async () => {
      if (!this.#current) {
        this.#current = this.#open();
      }
    });
  }

  /** Close the cache unless it is closed. */
  stop() {
    return this.#then(async () => {
      const current = this.#current;
      this.#current = null;
      await current?.close();
    });
  }

  /**
   * Run one opening or closing after the previous one has finished, so a
   * close and an open asked for close together never overlap.
   *
   * @param {() => Promise<void>} step
   * @returns {Promise<void>}
   */
  #then(step) {
    this.#steps = this.#steps.then(step, step);
    return this.#steps;
  }

  /**
   * @param {string} prefix
   * @returns {{ get: (key: string) => Promise<unknown>, set: (key: string, value: unknown, ttlMs?: number) => Promise<unknown> }}
   */
  namespace(prefix) {
    return {
      get: (key) => this.#current?.namespace(prefix).get(key) ?? Promise.resolve(undefined),
      set: (key, value, ttlMs) => this.#current?.namespace(prefix).set(key, value, ttlMs) ?? Promise.resolve(undefined)
    };
  }
}
