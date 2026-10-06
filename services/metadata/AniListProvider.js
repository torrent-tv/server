/**
 * @file AniList as a metadata provider, asked after TMDB.
 *
 * Anime searches supplement TMDB; they never replace an ambiguous TMDB answer.
 * The provider reads the answer so far (`prior`) and either confirms it with an
 * AniList record, or, when TMDB found nothing, identifies the work itself and
 * asks the primary sources again with the names AniList states.
 */

import { EVIDENCE, MetadataProvider, STAGE } from "./MetadataProvider.js";
import { parseReleaseName } from "./release-name.js";
import { normalizeTitle } from "./title.js";
import { RequestGate, MetadataUnavailableError } from "./RequestGate.js";
import { MetadataCache } from "./MetadataCache.js";
import { readBoundedBody } from "./bounded-body.js";
import { preferYearMatches } from "./identification.js";
import { providerFailure, providerResponseError } from "./provider-diagnostics.js";

const QUERY = `query($search:String!, $page:Int!) {
  Page(page:$page, perPage:50) {
    pageInfo { hasNextPage }
    media(search:$search, type:ANIME, isAdult:false) {
      id title { romaji english native } synonyms format episodes startDate { year }
    }
  }
}`;

/** The statuses of an answer that mean no work was found yet. */
const UNRESOLVED = ["not-found", "undetermined", "unavailable"];

export function hasAnimeHints(names) {
  return names.some(name => /(?:\banime\b|аниме|\bOVA\b|\bONA\b|\[(?:HorribleSubs|SubsPlease|Erai-raws|Judas|ASW)\])/iu.test(name));
}

/**
 * An AniList media reduced to the common fields.
 *
 * @param {object} anilist
 * @returns {Record<string, unknown>}
 */
export function anilistFields(anilist) {
  return {
    kind: anilist.format === "MOVIE" ? "movie" : "series",
    title: anilist.title?.english || anilist.title?.romaji || anilist.title?.native || undefined,
    originalTitle: anilist.title?.native || undefined,
    year: anilist.startDate?.year ?? undefined,
    isAnime: true
  };
}

export class AniListProvider extends MetadataProvider {
  #fetch;
  #gate;
  #cache = new MetadataCache({ budgetBytes: 1024 * 1024, maxEntryBytes: 128 * 1024 });
  #pending = new Map();

  constructor({ fetch = globalThis.fetch, gate = new RequestGate({ concurrency: 1, perSecond: 0.45, queueLimit: 8 }), cache } = {}) {
    super({ name: "anilist", stage: STAGE.supplement, takes: [EVIDENCE.names] });
    this.#fetch = fetch;
    this.#gate = gate;
    if (cache) this.#cache = cache;
  }

  interestedIn(names, work) {
    return hasAnimeHints(names) || Boolean(work?.anime);
  }

  fields(record) {
    return anilistFields(record);
  }

  async identify(request, { prior, again }) {
    const answer = prior;
    const hinted = hasAnimeHints(request.names);
    if (!hinted && !UNRESOLVED.includes(answer.status) && !answer.work?.anime) return answer;
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
          if (exact && Number.isInteger(media.id) && media.format &&
            (!request.kindHint || request.kindHint === kind) && (!answer.work?.kind || answer.work.kind === kind)) matches.set(media.id, media);
        }
      }));
    } catch (error) {
      if (error instanceof MetadataUnavailableError) { providerFailure("anilist", "identify", error); return answer; }
      throw error;
    }
    const found = preferYearMatches([...matches.values()].map(media => ({ media, year: media.startDate?.year })), years).map(({ media }) => media);
    if (answer.status === "identified") {
      const media = !incomplete && found.length === 1 && found.find(m =>
        Object.values(m.title ?? {}).some(n => n && [answer.work.title, answer.work.originalTitle].some(t => normalizeTitle(t) === normalizeTitle(n))));
      return media ? { ...answer, records: { ...answer.records, anilist: media } } : answer;
    }
    if (!UNRESOLVED.includes(answer.status) || incomplete || found.length !== 1) return answer;
    const [media] = found;
    const kind = media.format === "MOVIE" ? "movie" : "tv";
    const names = [media.title.english, media.title.romaji, media.title.native].filter(Boolean).slice(0, 3);
    const mapped = await again({ ...request, names: names.map(n => [n, media.startDate?.year].filter(value => value != null).join(" ")), kindHint: kind });
    if (mapped.status === "identified") return { ...mapped, records: { ...mapped.records, anilist: media } };
    return { status: "identified", records: { anilist: media }, work: { source: "anilist", anilistId: media.id, anime: true, animeFormat: media.format,
      kind, title: media.title.english || media.title.romaji || media.title.native, originalTitle: media.title.native,
      year: media.startDate?.year ?? null, seasons: [], poster: null, backdrop: null } };
  }

  async #search(title) {
    const cached = await this.#cache.get(title);
    if (cached) return cached;
    if (this.#pending.has(title)) return this.#pending.get(title);
    const pending = this.#gate.run(async () => {
      let response;
      try {
        response = await this.#fetch("https://graphql.anilist.co", {
          method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({ query: QUERY, variables: { search: title, page: 1 } }), signal: AbortSignal.timeout(4000)
        });
      } catch (cause) { throw new MetadataUnavailableError("AniList did not answer", { cause }); }
      if (response.status === 429 || response.headers.get("x-ratelimit-remaining") === "0") {
        const retry = Number(response.headers.get("retry-after"));
        this.#gate.pause(Date.now() + (retry > 0 ? retry : 60) * 1000);
      }
      if (!response.ok) throw new MetadataUnavailableError("AniList refused the search", { cause: await providerResponseError(response) });
      let body;
      try { body = JSON.parse((await readBoundedBody(response, 128 * 1024)).toString("utf8")); }
      catch (cause) { throw new MetadataUnavailableError("AniList returned invalid data", { cause }); }
      if (body.errors || !Array.isArray(body.data?.Page?.media)) {
        const cause = new Error("AniList search was incomplete");
        cause.providerMessage = JSON.stringify(body.errors ?? []);
        throw new MetadataUnavailableError("AniList search was incomplete", { cause });
      }
      const result = { media: body.data.Page.media, incomplete: body.data.Page.pageInfo?.hasNextPage !== false };
      await this.#cache.set(title, result, 60 * 60 * 1000);
      return result;
    }, { deadlineAt: Date.now() + 10_000 });
    this.#pending.set(title, pending);
    try { return await pending; } finally { this.#pending.delete(title); }
  }
}