import { SubtitleProvider } from "./SubtitleProvider.js";
import { MetadataUnavailableError } from "../metadata/RequestGate.js";

export class OpenSubtitles extends SubtitleProvider {
  #downloadsPausedUntil = 0;

  constructor({ key, fetch }) {
    super({ name: "opensubtitles", origin: "https://api.opensubtitles.com", headers: { "Api-Key": key }, fetch });
  }

  async search(query) {
    if (!query.tmdbId) return { items: [], status: "not-applicable" };
    const params = new URLSearchParams({ tmdb_id: String(query.tmdbId), type: query.kind === "movie" ? "movie" : "episode" });
    if (query.kind !== "movie") { params.set("parent_tmdb_id", String(query.tmdbId)); params.delete("tmdb_id"); params.set("season_number", String(query.season)); params.set("episode_number", String(query.episode)); }
    if (query.kind === "movie" && query.imdbId) {
      params.delete("tmdb_id");
      params.set("imdb_id", String(Number(query.imdbId.slice(2))));
    }
    const items = [];
    const deadlineAt = Date.now() + 25_000;
    let pages = 1;
    let readPages = 0;
    for (let page = 1; page <= Math.min(pages, 20); page++) {
      if (Date.now() >= deadlineAt) break;
      // The API redirects default pages and unsorted query parameters. Use
      // canonical URLs so credentials never need to follow an API redirect.
      if (page === 1) params.delete("page");
      else params.set("page", String(page));
      params.sort();
      const data = await this.http.json(`/api/v1/subtitles?${params}`, undefined, { deadlineAt });
      if (!Array.isArray(data.data) || !Number.isInteger(data.total_pages)) throw new MetadataUnavailableError("invalid subtitle search response");
      pages = data.total_pages;
      readPages = page;
      for (const record of data.data) {
        const attr = record.attributes;
        // Multi-CD files require joining timelines; do not offer one part as a whole film.
        if (!attr || attr.files?.length !== 1) continue;
        const file = attr.files[0];
        if (!Number.isSafeInteger(file.file_id) || !/^[a-z]{2,3}(?:-[A-Za-z]+)?$/u.test(attr.language ?? "")) continue;
        items.push({ provider: this.name, id: String(file.file_id), language: attr.language,
          filename: String(file.file_name ?? "subtitles.srt").slice(0, 500), release: String(attr.release ?? "").slice(0, 500),
          hearingImpaired: attr.hearing_impaired === true, forced: attr.foreign_parts_only === true,
          downloads: Number(attr.download_count) || 0, rating: Number(attr.ratings) || 0 });
      }
    }
    return { items, status: pages > readPages ? "partial" : "complete" };
  }

  async download(item) {
    if (this.#downloadsPausedUntil > Date.now()) throw new MetadataUnavailableError("subtitle download quota exhausted");
    let data;
    try { data = await this.http.json("/api/v1/download", { file_id: Number(item.id), sub_format: "webvtt" }); }
    catch (error) {
      // The provider's refusal may be quota-related. The shared HTTP pause
      // handles 429; do not retry a paid download automatically.
      if (error.httpStatus === 406) this.#downloadsPausedUntil = error.resetAt;
      throw error;
    }
    if (data.remaining === 0) {
      this.#downloadsPausedUntil = Date.parse(data.reset_time_utc) || Date.now() + 24 * 60 * 60_000;
    }
    if (typeof data.link !== "string") throw new MetadataUnavailableError("no subtitle download link");
    const bytes = await this.http.file(data.link, ["www.opensubtitles.com", "dl.opensubtitles.com", "vip-api.opensubtitles.com"]);
    return { bytes, filename: data.file_name ?? "subtitles.vtt" };
  }
}
