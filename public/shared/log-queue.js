/**
 * @file The browser's log lines between being written and being delivered.
 *
 * A line is kept until a batch carrying it has been accepted by someone. A
 * batch that fails comes back to the front of the queue and goes out again
 * with the next send; nothing is thrown away except by the queue's own limit,
 * and that is counted.
 *
 * Every failure is counted by its cause, and the counts are written into the
 * log itself as one line, which travels with the next batch. A page whose log
 * goes quiet then says, when it is heard again, what it lost and why — the
 * reading a 2026-09-06 failure did not have, when the page's lines stopped at
 * the moment delivery to the viewer wedged and nothing recorded the reason
 * (torrent-tv/meta#77).
 *
 * Pure: no `window`, no network. `client-logger.js` owns both.
 */

/**
 * Lines per batch: what both receivers accept. The proxy's and the server's
 * `POST /api/client-logs` each keep the first 50 lines of a body and ignore the
 * rest, so a larger batch would lose lines at the far end without a word.
 */
export const MAX_BATCH_LINES = 50;

/**
 * Bytes per batch body. The Fetch standard refuses a `keepalive` request when
 * its body and every other `keepalive` body still in flight from the page add
 * up to more than 64 KiB, and `navigator.sendBeacon` is held to the same quota.
 * A batch of 50 lines of up to 2000 characters each reaches 100 KB, so without
 * this bound a long batch is refused by the browser itself.
 */
export const MAX_BATCH_BYTES = 65536;

const encoder = new TextEncoder();

/**
 * Size of a string as UTF-8, which is what the body is sent as.
 *
 * @param {string} text
 * @returns {number}
 */
export function utf8Bytes(text) {
  return encoder.encode(text).length;
}

/**
 * @typedef {{ level: string, ts: string, msg: string }} LogLine
 * @typedef {{ seq: number, lines: LogLine[], body: string, bytes: number }} LogBatch
 */

export class LogQueue {
  /** @type {LogLine[]} */
  #lines = [];
  #capacity;
  #maxLines;
  #maxBytes;
  /** @type {(lines: LogLine[], seq: number) => string} */
  #frame;
  #nextSeq = 1;
  /** Lines the queue's limit pushed out since the last report. */
  #overflowed = 0;
  /** @type {Map<string, number>} failures by route and cause since the last report */
  #failures = new Map();
  /** When the counts being collected began. @type {string | null} */
  #since = null;
  /** @type {() => string} */
  #now;
  /**
   * The report line still on its way, if any. Until it has been delivered no
   * second one is written: the counts keep growing and go out in the next. A
   * page that cannot reach anyone for an hour would otherwise fill its own
   * queue with reports, one per attempt, and push out the lines they are about.
   * @type {LogLine | null}
   */
  #pendingReport = null;

  /**
   * @param {{
   *   capacity: number,
   *   frame: (lines: LogLine[], seq: number) => string,
   *   maxLines?: number,
   *   maxBytes?: number,
   *   now?: () => string
   * }} options - `frame` builds the body a batch is sent as.
   */
  constructor({ capacity, frame, maxLines = MAX_BATCH_LINES, maxBytes = MAX_BATCH_BYTES, now }) {
    this.#capacity = capacity;
    this.#frame = frame;
    this.#maxLines = maxLines;
    this.#maxBytes = maxBytes;
    this.#now = typeof now === "function" ? now : () => new Date().toISOString().slice(11, 23);
  }

  /** @returns {number} */
  get size() {
    return this.#lines.length;
  }

  /**
   * @param {LogLine} line
   * @returns {void}
   */
  push(line) {
    this.#lines.push(line);
    this.#trim();
  }

  /**
   * The next batch: as many lines from the front as fit both limits, and always
   * at least one, so a single line larger than the byte limit cannot stop the
   * queue behind it. The size is counted exactly — the body's frame once, each
   * line's JSON once, and one comma between lines — rather than estimated.
   *
   * @returns {LogBatch | null}
   */
  take() {
    if (this.#lines.length === 0) {
      return null;
    }
    const seq = this.#nextSeq++;
    let bytes = utf8Bytes(this.#frame([], seq));
    let count = 0;
    while (count < this.#lines.length && count < this.#maxLines) {
      const added = utf8Bytes(JSON.stringify(this.#lines[count])) + (count > 0 ? 1 : 0);
      if (count > 0 && bytes + added > this.#maxBytes) {
        break;
      }
      bytes += added;
      count += 1;
    }
    const lines = this.#lines.splice(0, count);
    return { seq, lines, body: this.#frame(lines, seq), bytes };
  }

  /**
   * A route refused a batch or never answered. Counted, and nothing more: the
   * caller may still deliver the batch another way.
   *
   * @param {string} route - Where it was sent: `proxy`, `server`, `beacon`.
   * @param {unknown} cause
   * @returns {void}
   */
  noteFailure(route, cause) {
    this.#since ??= this.#now();
    const key = `${route}: ${describe(cause)}`;
    this.#failures.set(key, (this.#failures.get(key) ?? 0) + 1);
  }

  /**
   * A route accepted the batch.
   *
   * @param {LogBatch} batch
   * @returns {void}
   */
  delivered(batch) {
    if (this.#pendingReport !== null && batch.lines.includes(this.#pendingReport)) {
      this.#pendingReport = null;
    }
  }

  /**
   * No route took the batch: its lines go back to the front, in their order,
   * to leave with the next send.
   *
   * @param {LogBatch} batch
   * @returns {void}
   */
  giveBack(batch) {
    this.#lines.unshift(...batch.lines);
    this.#trim();
  }

  /**
   * The line that says what was lost and what failed since the last such line,
   * put at the front of the queue so it leaves with the next batch; nothing
   * when nothing happened, or while the previous one has not been delivered.
   * The counts start again from zero. If the batch carrying it fails, the line
   * comes back with that batch like any other.
   *
   * @returns {void}
   */
  reportLosses() {
    if (this.#pendingReport !== null || (this.#overflowed === 0 && this.#failures.size === 0)) {
      return;
    }
    // Room first, so the limit cannot push out the report itself — the report
    // goes to the front, and the front is where the limit takes from.
    const excess = this.#lines.length + 1 - this.#capacity;
    if (excess > 0) {
      this.#drop(excess);
    }
    const parts = [];
    if (this.#overflowed > 0) {
      parts.push(`${this.#overflowed} line(s) pushed out by the ${this.#capacity}-line limit and lost`);
    }
    for (const [key, count] of this.#failures) {
      parts.push(`${key} ×${count}`);
    }
    const msg = `[client-logger] since ${this.#since}: ${parts.join("; ")}`;
    this.#overflowed = 0;
    this.#failures.clear();
    this.#since = null;
    this.#pendingReport = { level: "warn", ts: this.#now(), msg };
    this.#lines.unshift(this.#pendingReport);
  }

  /** @returns {void} */
  #trim() {
    const excess = this.#lines.length - this.#capacity;
    if (excess > 0) {
      this.#drop(excess);
    }
  }

  /**
   * Push the oldest lines out, counted. A report among them is lost with them,
   * and the next report says so by the count it carries.
   *
   * @param {number} count
   * @returns {void}
   */
  #drop(count) {
    this.#since ??= this.#now();
    const dropped = this.#lines.splice(0, count);
    this.#overflowed += count;
    if (this.#pendingReport !== null && dropped.includes(this.#pendingReport)) {
      this.#pendingReport = null;
    }
  }
}

/**
 * @param {unknown} cause
 * @returns {string}
 */
function describe(cause) {
  if (cause instanceof Error) {
    return `${cause.name}: ${cause.message}`;
  }
  return typeof cause === "string" ? cause : String(cause);
}
