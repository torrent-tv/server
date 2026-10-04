import { RequestGate, MetadataUnavailableError } from "../metadata/RequestGate.js";
import { readBoundedBody } from "../metadata/bounded-body.js";

export function retryAt(headers, now = Date.now()) {
  const retry = headers.get("retry-after");
  const seconds = Number(retry);
  const after = Number(headers.get("x-ratelimit-reset-after"));
  const reset = Number(headers.get("x-ratelimit-reset"));
  const resetSeconds = Number(headers.get("ratelimit-reset"));
  if (!retry && !(after > 0) && !(reset > 0) && !(resetSeconds > 0)) return now + 60_000;
  return Math.max(now + 1000, retry && Number.isFinite(seconds) ? now + seconds * 1000 : Date.parse(retry) || 0,
    after > 0 ? now + after * 1000 : 0, reset > 0 ? reset * 1000 : 0,
    resetSeconds > 0 ? now + resetSeconds * 1000 : 0);
}

/** One shared request budget per provider, not one per viewer or endpoint. */
export class ProviderHttp {
  constructor({ origin, headers, fetch = globalThis.fetch, perSecond = 1 }) {
    this.origin = origin;
    this.headers = { "User-Agent": "TorrentTV v1", ...headers };
    this.fetch = fetch;
    // A conservative local ceiling; response headers can require longer pauses.
    this.gate = new RequestGate({ concurrency: 1, perSecond, queueLimit: 16 });
  }

  async json(path, body, { deadlineAt = Date.now() + 20_000 } = {}) {
    return this.gate.run(async () => {
      const response = await this.fetch(new URL(path, this.origin), {
        headers: { ...this.headers, Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}) },
        method: body ? "POST" : "GET", body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(Math.max(1, Math.min(8000, deadlineAt - Date.now()))), redirect: "error"
      });
      if (response.status === 429 || response.headers.get("x-ratelimit-remaining") === "0" || response.headers.get("ratelimit-remaining") === "0") {
        this.gate.pause(retryAt(response.headers));
      }
      if (!response.ok) {
        const error = new MetadataUnavailableError(`provider returned ${response.status}`);
        error.httpStatus = response.status;
        if (response.status === 406) {
          try {
            const body = JSON.parse((await readBoundedBody(response, 8192)).toString("utf8"));
            error.resetAt = Date.parse(body.reset_time_utc) || Date.now() + 24 * 60 * 60_000;
          } catch { error.resetAt = Date.now() + 24 * 60 * 60_000; }
        } else await response.body?.cancel();
        throw error;
      }
      return JSON.parse((await readBoundedBody(response, 1024 * 1024)).toString("utf8"));
    }, { deadlineAt, priority: body ? 1 : 0 });
  }

  async file(address, allowedHosts) {
    const deadlineAt = Date.now() + 20_000;
    return this.gate.run(async () => {
      let url = new URL(address);
      for (let redirects = 0; redirects < 4; redirects++) {
        if (url.protocol !== "https:" || url.username || url.password || url.port || !allowedHosts.includes(url.hostname)) {
          throw new MetadataUnavailableError("invalid provider download address");
        }
        // API credentials must not be forwarded to file hosts or redirects.
        if (Date.now() >= deadlineAt) throw new MetadataUnavailableError("subtitle download deadline passed");
        const response = await this.fetch(url, { headers: { "User-Agent": "TorrentTV v1" }, signal: AbortSignal.timeout(Math.min(15_000, deadlineAt - Date.now())), redirect: "manual" });
        if (response.status === 429) this.gate.pause(retryAt(response.headers));
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          const location = response.headers.get("location");
          await response.body?.cancel();
          if (!location) break;
          url = new URL(location, url);
          continue;
        }
        if (!response.ok) { await response.body?.cancel(); throw new MetadataUnavailableError(`subtitle download returned ${response.status}`); }
        return readBoundedBody(response, 4 * 1024 * 1024);
      }
      throw new MetadataUnavailableError("too many download redirects");
    }, { deadlineAt, priority: 1 });
  }
}
