import { normalizeWork } from "./normalize-work.js";
import { parseReleaseName } from "./release-name.js";
import { normalizeTitle } from "./title.js";
import { RequestGate, MetadataUnavailableError } from "./RequestGate.js";
import { MetadataCache } from "./MetadataCache.js";
import { readBoundedBody } from "./bounded-body.js";

const QUERY = `query($search:String!, $page:Int!) {
  Page(page:$page, perPage:50) {
    pageInfo { hasNextPage }
    media(search:$search, type:ANIME, isAdult:false) {
      id title { romaji english native } synonyms format episodes startDate { year }
    }
  }
}`;

export function hasAnimeHints(names) {
  return names.some(name => /(?:\banime\b|аниме|\bOVA\b|\bONA\b|\[(?:HorribleSubs|SubsPlease|Erai-raws|Judas|ASW)\])/iu.test(name));
}

/** Anime searches supplement TMDB; they never replace an ambiguous TMDB answer. */
export class AnimeMetadata {
  #tmdb;
  #fetch;
  #gate;
  #cache = new MetadataCache({ budgetBytes: 1024 * 1024, maxEntryBytes: 128 * 1024 });
  #pending = new Map();

  constructor(tmdb, { fetch = globalThis.fetch, gate = new RequestGate({ concurrency: 1, perSecond: 0.45, queueLimit: 8 }) } = {}) {
    this.#tmdb = tmdb;
    this.#fetch = fetch;
    this.#gate = gate;
  }

  episodes(request) { return this.#tmdb.episodes(request); }

  async identify(request) {
    let result = await this.#identify(request);
    if (result.status === "not-found" && this.#tmdb.identifyTransliterated) {
      result = await this.#tmdb.identifyTransliterated(request);
      if (result.status === "identified" && (hasAnimeHints(request.names) || result.work?.anime)) {
        const enriched = await this.#identify({ ...request, names: [`${result.work.title} ${result.work.year}`], kindHint: result.work.kind });
        if (enriched.status === "identified" && enriched.work?.tmdbId === result.work.tmdbId) result = enriched;
      }
    }
    if (result.status !== "identified") return result;
    const tmdb = result.work?.source === "anilist" ? null : result.work;
    return { status: "identified", work: normalizeWork(tmdb, result.anilist ?? null) };
  }

  async #identify(request) {
    const answer = await this.#tmdb.identify(request);
    const hinted = hasAnimeHints(request.names);
    if (!hinted && answer.status !== "not-found" && !answer.work?.anime) return answer;
    const readings = request.names.map(parseReleaseName);
    const years = [...new Set(readings.map(r => r.years?.from).filter(Number.isInteger))];
    if (answer.work?.year && !years.length) years.push(answer.work.year);
    const titles = [...new Set(readings.flatMap(r => r.titles))];
    if (answer.work?.anime) titles.unshift(answer.work.originalTitle, answer.work.title);
    const queries = [...new Set(titles.filter(Boolean))].slice(0, 4);
    const matches = new Map();
    let incomplete = [...new Set(titles.filter(Boolean))].length > 4;
    try {
      await Promise.all(queries.map(async title => {
        const result = await this.#search(title);
        incomplete ||= result.incomplete;
        for (const media of result.media) {
          const names = [...Object.values(media.title ?? {}), ...(media.synonyms ?? [])].filter(Boolean);
          const exact = names.some(name => normalizeTitle(name) === normalizeTitle(title) ||
            parseReleaseName(name).titles.some(alias => normalizeTitle(alias) === normalizeTitle(title)));
          const kind = media.format === "MOVIE" ? "movie" : "tv";
          if (exact && Number.isInteger(media.id) && media.format && years.includes(media.startDate?.year) &&
            (!request.kindHint || request.kindHint === kind) && (!answer.work?.kind || answer.work.kind === kind)) matches.set(media.id, media);
        }
      }));
    } catch (error) {
      if (error instanceof MetadataUnavailableError) return answer;
      throw error;
    }
    if (answer.status === "identified") {
      const media = !incomplete && matches.size === 1 && [...matches.values()].find(m =>
        Object.values(m.title ?? {}).some(n => n && [answer.work.title, answer.work.originalTitle].some(t => normalizeTitle(t) === normalizeTitle(n))));
      return media ? { ...answer, anilist: media } : answer;
    }
    if (answer.status !== "not-found" || incomplete || matches.size !== 1) return answer;
    const [media] = matches.values();
    const kind = media.format === "MOVIE" ? "movie" : "tv";
    const names = [media.title.english, media.title.romaji, media.title.native].filter(Boolean).slice(0, 3);
    const mapped = await this.#tmdb.identify({ ...request, names: names.map(n => `${n} ${media.startDate.year}`), kindHint: kind });
    if (mapped.status === "identified") return { ...mapped, anilist: media };
    return { status: "identified", anilist: media, work: { source: "anilist", anilistId: media.id, anime: true, animeFormat: media.format,
      kind, title: media.title.english || media.title.romaji || media.title.native, originalTitle: media.title.native,
      year: media.startDate.year, seasons: [], poster: null, backdrop: null } };
  }

  async #search(title) {
    const cached = this.#cache.get(title);
    if (cached) return cached;
    if (this.#pending.has(title)) return this.#pending.get(title);
    const pending = this.#gate.run(async () => {
      let response;
      try {
        response = await this.#fetch("https://graphql.anilist.co", {
          method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({ query: QUERY, variables: { search: title, page: 1 } }), signal: AbortSignal.timeout(4000)
        });
      } catch { throw new MetadataUnavailableError("AniList did not answer"); }
      if (response.status === 429 || response.headers.get("x-ratelimit-remaining") === "0") {
        const retry = Number(response.headers.get("retry-after"));
        this.#gate.pause(Date.now() + (retry > 0 ? retry : 60) * 1000);
      }
      if (!response.ok) { await response.body?.cancel(); throw new MetadataUnavailableError("AniList refused the search"); }
      let body;
      try { body = JSON.parse((await readBoundedBody(response, 128 * 1024)).toString("utf8")); }
      catch { throw new MetadataUnavailableError("AniList returned invalid data"); }
      if (body.errors || !Array.isArray(body.data?.Page?.media)) throw new MetadataUnavailableError("AniList search was incomplete");
      const result = { media: body.data.Page.media, incomplete: body.data.Page.pageInfo?.hasNextPage !== false };
      this.#cache.set(title, result, 60 * 60 * 1000);
      return result;
    }, { deadlineAt: Date.now() + 10_000 });
    this.#pending.set(title, pending);
    try { return await pending; } finally { this.#pending.delete(title); }
  }
}
