import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { SharedFetches } from "../metadata/SharedFetches.js";
import { subtitleVtt } from "./convert.js";
import { providerFailure, providerOutcome } from "../metadata/provider-diagnostics.js";

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;

export function validateSubtitleQuery(body) {
  if (!body || !["movie", "series"].includes(body.kind)) return null;
  const positive = n => Number.isSafeInteger(n) && n > 0 && n <= 2147483647;
  if (!positive(body.tmdbId) && !positive(body.anilistId)) return null;
  if (body.tmdbId != null && !positive(body.tmdbId)) return null;
  if (body.anilistId != null && !positive(body.anilistId)) return null;
  const query = { kind: body.kind, tmdbId: body.tmdbId ?? null, anilistId: body.anilistId ?? null };
  if (body.kind === "series") {
    if (body.tmdbId && !(Number.isInteger(body.season) && body.season >= 0 && body.season <= 999 && positive(body.episode) && body.episode <= 9999)) return null;
    if (body.anilistEpisode != null && !(positive(body.anilistEpisode) && body.anilistEpisode <= 9999)) return null;
    Object.assign(query, { season: body.season ?? null, episode: body.episode ?? null, anilistEpisode: body.anilistEpisode ?? null });
  }
  return query;
}

/** Search records are shared; download permits are issued only for those records. */
export class SubtitleService {
  #cache;
  #providers;
  #secret = randomBytes(32);
  #fetches = new SharedFetches({ waiterLimit: 64 });
  #fileFetches = new SharedFetches({ waiterLimit: 32 });
  #activeDownloads = 0;

  constructor({ cache, providers }) { this.#cache = cache; this.#providers = providers; }

  #sign(payload) { return createHmac("sha256", this.#secret).update(payload).digest("base64url"); }

  #permit(item) {
    const payload = Buffer.from(JSON.stringify({ item, until: Date.now() + DAY })).toString("base64url");
    return `${payload}.${this.#sign(payload)}`;
  }

  #readPermit(token) {
    if (typeof token !== "string" || token.length > 6000) return null;
    const [payload, signature, extra] = token.split(".");
    if (!payload || !signature || extra) return null;
    const expected = Buffer.from(this.#sign(payload));
    const actual = Buffer.from(signature);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
    try {
      const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
      return decoded.until > Date.now() ? decoded.item : null;
    } catch { return null; }
  }

  async search(query, signal) {
    const results = await Promise.all(this.#providers.map(async provider => {
      // Provider-specific keys omit inputs that cannot change that provider's answer.
      const parameters = provider.name === "jimaku" ? [query.kind, query.anilistId, query.anilistEpisode ?? null] : [query.kind, query.tmdbId, query.season ?? null, query.episode ?? null];
      const key = `list|${provider.name}|${JSON.stringify(parameters)}`;
      let answer = await this.#cache.get(key);
      const cacheHit = answer !== undefined;
      try {
        if (answer === undefined) answer = await this.#fetches.join(key, async () => {
          const cached = await this.#cache.get(key);
          if (cached !== undefined) return cached;
          const result = await provider.search(query);
          if (result.status === "complete") await this.#cache.set(key, result, result.items.length ? DAY : HOUR);
          // Keep successfully retrieved, explicitly partial offers briefly too.
          // Their status remains partial; a missing language is never an absence.
          if (result.status === "partial" && result.items.length) await this.#cache.set(key, result, HOUR);
          return result;
        }, { deadlineAt: Date.now() + 30_000, signal });
        providerOutcome(provider.name, "subtitle-search", { status: answer.status, cacheHit, count: answer.items.length, tmdbId: query.tmdbId, anilistId: query.anilistId });
        return { provider: provider.name, status: answer.status, items: answer.items.map(item => {
          const { url: _url, ...publicItem } = item;
          return { ...publicItem, token: this.#permit(item) };
        }) };
      } catch (error) {
        providerFailure(provider.name, "subtitle-search", error);
        return { provider: provider.name, status: "unavailable", items: [] };
      }
    }));
    return { providers: results };
  }

  async file(token, signal) {
    const item = this.#readPermit(token);
    if (!item) return { status: "expired" };
    const provider = this.#providers.find(p => p.name === item.provider);
    if (!provider) return { status: "unavailable" };
    const key = `file|v1|${item.provider}|${item.id}`;
    const held = await this.#cache.get(key);
    if (held !== undefined) return { status: "ready", vtt: held.vtt };
    try {
      const value = await this.#fileFetches.join(key, async () => {
        const cached = await this.#cache.get(key);
        if (cached !== undefined) return cached;
        if (this.#activeDownloads >= 4) throw new Error("too many subtitle downloads");
        this.#activeDownloads++;
        try {
          const source = await provider.download(item);
          const vtt = subtitleVtt(source.bytes, source.filename, item.language);
          const value = { vtt };
          await this.#cache.set(key, value, 30 * DAY);
          return value;
        } finally { this.#activeDownloads--; }
      }, { deadlineAt: Date.now() + 45_000, signal });
      return { status: "ready", vtt: value.vtt };
    } catch (error) {
      providerFailure(provider.name, "subtitle-download", error);
      return { status: "unavailable" };
    }
  }
}
