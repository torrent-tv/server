import { SubtitleProvider } from "./SubtitleProvider.js";
import { MetadataUnavailableError } from "../metadata/RequestGate.js";

export class OpenSubtitles extends SubtitleProvider {
  #downloadsPausedUntil = 0;

  constructor({ key, fetch }) {
    super({ name: "opensubtitles", origin: "https://api.opensubtitles.com", headers: { "Api-Key": key }, fetch });
  }

  async search(query) {
    if (!query.tmdbId && !query.fingerprint) return { items: [], status: "not-applicable" };
    const params = new URLSearchParams();
    if (query.tmdbId && query.kind === "movie") {
      params.set("tmdb_id", String(query.tmdbId));
      params.set("type", "movie");
    }
    if (query.tmdbId && query.kind === "series" && Number.isInteger(query.season) && Number.isInteger(query.episode)) {
      params.set("parent_tmdb_id", String(query.tmdbId));
      params.set("season_number", String(query.season));
      params.set("episode_number", String(query.episode));
      params.set("type", "episode");
    }
    if (query.kind === "movie" && query.imdbId) {
      params.delete("tmdb_id");
      params.set("imdb_id", String(Number(query.imdbId.slice(2))));
    }
    if (query.fingerprint) params.set("moviehash", query.fingerprint.hash);
    if (query.fingerprint && !query.tmdbId && query.query) params.set("query", query.query);
    if (query.fingerprint && !query.tmdbId && query.kind === "movie") params.set("type", "movie");
    if (query.fingerprint && !query.tmdbId && query.kind === "series") params.set("type", "episode");
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
        const item = { provider: this.name, id: String(file.file_id), language: attr.language,
          filename: String(file.file_name ?? "subtitles.srt").slice(0, 500), release: String(attr.release ?? "").slice(0, 500),
          hearingImpaired: attr.hearing_impaired === true, forced: attr.foreign_parts_only === true,
          downloads: Number.isSafeInteger(attr.download_count) && attr.download_count >= 0 ? attr.download_count : null,
          rating: Number(attr.ratings) || 0,
          aiTranslated: attr.ai_translated === true, machineTranslated: attr.machine_translated === true };
        const uploaderName = typeof attr.uploader?.name === "string" ? attr.uploader.name.trim() : "";
        if (uploaderName) item.uploaderName = uploaderName.slice(0, 100);
        if (typeof attr.upload_date === "string" && Number.isFinite(Date.parse(attr.upload_date))) {
          item.uploadDate = attr.upload_date.slice(0, 40);
        }
        if (query.fingerprint) {
          item.eligibility = attr.moviehash_match === true ? "suitable" : "unknown";
          item.eligibilityReason = attr.moviehash_match === true ? "OpenSubtitles reports a matching file hash." : "No exact file-hash match was reported.";
          if (attr.moviehash_match === true) item.hashMatch = true;
          if (Number.isFinite(attr.fps) && attr.fps > 0) item.fps = attr.fps;
          if (typeof attr.hd === "boolean") item.hd = attr.hd;
        }
        const feature = attr.feature_details;
        if (feature && typeof feature === "object") {
          const number = value => Number.isSafeInteger(value) && value > 0 ? value : null;
          const episode = feature.feature_type === "Episode";
          const tmdbId = number(episode ? feature.parent_tmdb_id : feature.tmdb_id);
          const imdbNumber = number(episode ? feature.parent_imdb_id : feature.imdb_id);
          if (query.fingerprint && attr.moviehash_match === true && (tmdbId || imdbNumber)) {
            item.identity = {
              kind: episode ? "series" : "movie",
              ...(tmdbId ? { tmdbId } : {}),
              ...(imdbNumber ? { imdbId: `tt${imdbNumber}` } : {}),
              ...(!episode && Number.isInteger(feature.year) && feature.year >= 1888 && feature.year <= 2100 ? { year: feature.year } : {}),
              ...(typeof (episode ? feature.parent_title : feature.title) === "string"
                ? { title: (episode ? feature.parent_title : feature.title).slice(0, 300) } : {}),
              ...(episode && Number.isInteger(feature.season_number) && feature.season_number >= 0 ? { season: feature.season_number } : {}),
              ...(episode && Number.isInteger(feature.episode_number) && feature.episode_number > 0 ? { episode: feature.episode_number } : {})
            };
          }
        }
        items.push(item);
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
