import { createHash } from "node:crypto";
import { SubtitleProvider } from "./SubtitleProvider.js";
import { MetadataUnavailableError } from "../metadata/RequestGate.js";

export class Jimaku extends SubtitleProvider {

  constructor({ key, fetch }) {
    super({ name: "jimaku", origin: "https://jimaku.cc", headers: { Authorization: key }, fetch });
  }

  async search(query) {
    if (!query.anilistId || (query.kind !== "movie" && !Number.isInteger(query.anilistEpisode))) return { items: [], status: "not-applicable" };
    const entries = await this.http.json(`/api/entries/search?anilist_id=${query.anilistId}`);
    if (!Array.isArray(entries)) throw new MetadataUnavailableError("invalid Jimaku entries");
    const matching = entries.filter(entry => entry.anilist_id === query.anilistId && entry.flags?.movie === (query.kind === "movie") && entry.flags?.unverified !== true);
    if (matching.length !== 1) return { items: [], status: matching.length ? "ambiguous" : "complete" };
    const entry = matching[0];
    const files = await this.http.json(`/api/entries/${entry.id}/files${query.kind === "movie" ? "" : `?episode=${query.anilistEpisode}`}`);
    if (!Array.isArray(files)) throw new MetadataUnavailableError("invalid Jimaku file list");
    const items = [];
    for (const file of files) {
      if (typeof file.name !== "string" || typeof file.url !== "string" || file.url.length > 1500 || !/\.(srt|ass|ssa|vtt)$/iu.test(file.name) || file.size > 4 * 1024 * 1024) continue;
      // Jimaku's episode filter is explicitly a filename guess. Keep that fact
      // visible in the menu; do not claim a verified video timing match.
      const language = file.name.match(/(?:[.\[ _-])(ja|jpn|en|eng|ru|rus)(?=[.\] _-])/iu)?.[1]?.toLowerCase();
      const code = { jpn: "ja", eng: "en", rus: "ru" }[language] ?? language ?? "und";
      items.push({ provider: this.name, id: createHash("sha256").update(`${file.url}|${file.last_modified}`).digest("hex"),
        url: file.url, filename: file.name.slice(0, 500), release: file.name.slice(0, 500), language: code, episodeGuess: query.kind !== "movie" });
    }
    return { items, status: "complete" };
  }

  async download(item) {
    return { bytes: await this.http.file(item.url, ["jimaku.cc", "www.jimaku.cc"]), filename: item.filename };
  }
}
