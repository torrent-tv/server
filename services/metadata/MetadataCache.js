/**
 * @file What the provider has already answered, held in memory.
 *
 * It is a cache: the provider is the source of truth, and an empty cache after
 * a restart costs one request per title. Three properties are stated rather
 * than hoped for:
 *
 *  - **time** — every entry carries its own expiry, and TMDB's terms forbid
 *    keeping its data longer than six months; the longest expiry used is hours;
 *  - **size** — the budget counts the SERIALIZED size of what is kept (the
 *    JSON of the value plus its key). That is a counter, not the process's
 *    memory: JavaScript objects and strings cost more than their JSON, and the
 *    ratio is measured in the research note rather than assumed here. The
 *    oldest entries leave first when the budget is full;
 *  - **what is never kept** — a refusal (`MetadataUnavailableError`) never
 *    reaches here, because it says nothing about whether a work exists.
 */

export class MetadataCache {
  /** @type {Map<string, { value: unknown, bytes: number, expiresAt: number }>} */
  #entries = new Map();

  #bytes = 0;

  /** @type {number} */
  #budgetBytes;

  /** @type {number} */
  #maxEntryBytes;

  /** @type {() => number} */
  #now;

  /**
   * @param {object} params
   * @param {number} params.budgetBytes - Serialized bytes the whole cache may hold.
   * @param {number} params.maxEntryBytes - Serialized bytes one entry may hold.
   * @param {() => number} [params.now]
   */
  constructor({ budgetBytes, maxEntryBytes, now = Date.now }) {
    this.#budgetBytes = budgetBytes;
    this.#maxEntryBytes = maxEntryBytes;
    this.#now = now;
  }

  /**
   * @param {string} key
   * @returns {unknown} `undefined` when absent or expired.
   */
  get(key) {
    const entry = this.#entries.get(key);
    if (!entry) {
      return undefined;
    }
    if (entry.expiresAt <= this.#now()) {
      this.#remove(key, entry);
      return undefined;
    }
    // Most recently used goes to the end, so the oldest is always first.
    this.#entries.delete(key);
    this.#entries.set(key, entry);
    return entry.value;
  }

  /**
   * @param {string} key
   * @param {unknown} value
   * @param {number} ttlMs
   * @returns {boolean} `false` when the entry is larger than one entry may be.
   */
  set(key, value, ttlMs) {
    const bytes = Buffer.byteLength(JSON.stringify(value)) + Buffer.byteLength(key);
    const previous = this.#entries.get(key);
    if (previous) {
      this.#remove(key, previous);
    }
    if (bytes > this.#maxEntryBytes || bytes > this.#budgetBytes) {
      return false;
    }
    while (this.#bytes + bytes > this.#budgetBytes) {
      const [oldestKey, oldest] = this.#entries.entries().next().value;
      this.#remove(oldestKey, oldest);
    }
    this.#entries.set(key, { value, bytes, expiresAt: this.#now() + ttlMs });
    this.#bytes += bytes;
    return true;
  }

  /**
   * @returns {{ entries: number, bytes: number }}
   */
  stats() {
    return { entries: this.#entries.size, bytes: this.#bytes };
  }

  /**
   * @param {string} key
   * @param {{ bytes: number }} entry
   */
  #remove(key, entry) {
    this.#entries.delete(key);
    this.#bytes -= entry.bytes;
  }
}
