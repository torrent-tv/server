import { Worker } from "node:worker_threads";

/** Shared, persistent cache; the index and values remain on disk. */
export class DiskCache {
  #worker;
  #pending = new Map();
  #sequence = 0;
  #failed = false;
  #reported = false;
  #queuedBytes = 0;
  #now;
  #closing = false;

  constructor({ directory, budgetBytes = 1024 ** 3, reserveBytes = 256 * 1024 ** 2, maxEntryBytes = 8 * 1024 ** 2, now = Date.now }) {
    this.#now = now;
    this.#worker = new Worker(new URL("./cache-worker.js", import.meta.url), {
      workerData: { directory, budgetBytes, reserveBytes, maxEntryBytes }
    });
    this.#worker.on("message", ({ id, result, error }) => {
      if (error) this.#report(error);
      const pending = this.#pending.get(id);
      this.#queuedBytes -= pending?.bytes ?? 0;
      pending?.resolve(result);
      this.#pending.delete(id);
    });
    this.#worker.on("error", error => { this.#report(error.code ?? "worker-failed"); this.#stop("worker-failed"); });
    this.#worker.on("exit", () => { if (!this.#closing) this.#report("worker-exited"); this.#stop("worker-exited"); });
  }

  #report(reason) {
    if (this.#reported) return;
    this.#reported = true;
    console.warn(`[cache] disk cache unavailable: ${reason}`);
  }

  #stop(reason) {
    this.#failed = true;
    if (this.#pending.size) this.#report(reason);
    for (const { resolve } of this.#pending.values()) resolve(undefined);
    this.#pending.clear();
    this.#queuedBytes = 0;
  }

  #call(method, key, value, ttlMs) {
    // Bound queued values too: the disk budget is not a RAM budget.
    const bytes = method === "set" ? Buffer.byteLength(JSON.stringify(value)) : 0;
    if (this.#failed || this.#pending.size >= 16 || bytes > 8 * 1024 ** 2 || this.#queuedBytes + bytes > 16 * 1024 ** 2) return Promise.resolve(undefined);
    return new Promise(resolve => {
      const id = ++this.#sequence;
      this.#pending.set(id, { resolve, bytes });
      this.#queuedBytes += bytes;
      this.#worker.postMessage({ id, method, key, value, ttlMs, now: this.#now() });
    });
  }

  namespace(prefix) {
    return {
      get: key => this.#call("get", `${prefix}|${key}`),
      set: (key, value, ttlMs) => this.#call("set", `${prefix}|${key}`, value, ttlMs)
    };
  }

  async close() {
    this.#closing = true;
    await this.#call("close");
    await this.#worker.terminate();
  }
}
