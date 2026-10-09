/**
 * @file AniList as a metadata provider, asked after TMDB.
 *
 * Anime searches supplement TMDB; they never replace an ambiguous TMDB answer.
 * The provider reads the answer so far (`prior`) and either confirms it with an
 * AniList record, or, when TMDB found nothing, identifies the work itself and
 * asks the primary sources again with the names AniList states.
 */

import { CATEGORY, EVIDENCE, MetadataProvider, STAGE } from "./MetadataProvider.js";
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

const BY_ID = `query($id:Int!) {
  Media(id:$id, type:ANIME) {
    id title { romaji english native } synonyms format episodes startDate { year }
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
    super({ name: "anilist", stage: STAGE.supplement, takes: [EVIDENCE.names, EVIDENCE.externalIds], category: CATEGORY.general });
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
    if (Number.isInteger(request.externalIds?.anilist)) return this.#identifyById(request, { prior, again });
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
      const agreeing = !incomplete && found.length === 1 ? this.#agreeingCandidate(answer, found[0]) : null;
      if (agreeing) {
        // TMDB chose among several works of one title; the one anime AniList
        // holds under that title names which of them this is.
        const switched = await again({ ...request, externalIds: { ...request.externalIds, tmdb: { kind: agreeing.kind, id: agreeing.tmdbId } } });
        if (switched.status === "identified") {
          const tmdb = switched.records?.tmdb ? { tmdb: { ...switched.records.tmdb, identification: "anilist" } } : {};
          return { ...switched, ranked: answer.ranked, work: { ...switched.work, identification: "anilist" }, records: { ...switched.records, ...tmdb, anilist: found[0] } };
        }
      }
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

  /**
   * The TMDB candidate the one anime AniList found is, when TMDB chose a
   * different one: of its kind, started within a year of it, and contradicting
   * nothing the release states. `null` when none or more than one agree, or
   * TMDB's choice already agrees.
   *
   * @param {{ work: object, ranked?: Array<{ kind: string, tmdbId: number, year: number | null, contradiction: string | null }> }} answer
   * @param {object} media
   */
  #agreeingCandidate(answer, media) {
    const kind = media.format === "MOVIE" ? "movie" : "tv";
    const year = media.startDate?.year;
    if (!Array.isArray(answer.ranked) || answer.ranked.length < 2 || !Number.isInteger(year)) return null;
    const agree = (candidate) => candidate.kind === kind && Number.isInteger(candidate.year) && Math.abs(candidate.year - year) <= 1 && !candidate.contradiction;
    if (agree({ kind: answer.work.kind, year: answer.work.year, contradiction: null })) return null;
    const agreeing = answer.ranked.filter(agree);
    return agreeing.length === 1 ? agreeing[0] : null;
  }

  /**
   * The work an AniList id names: the record itself, and the TMDB work of the
   * same title and year when TMDB holds one. Asked when the page already knows
   * the id (from its address); no search by name decides it.
   */
  async #identifyById(request, { prior, again }) {
    let media;
    try {
      media = await this.#byId(request.externalIds.anilist);
    } catch (error) {
      if (error instanceof MetadataUnavailableError) { providerFailure("anilist", "identify-by-id", error); return prior; }
      throw error;
    }
    if (!media) return prior;
    const kind = media.format === "MOVIE" ? "movie" : "tv";
    const same = prior.status === "identified" && prior.work?.kind === kind && prior.work?.year === media.startDate?.year &&
      Object.values(media.title ?? {}).some(n => n && [prior.work.title, prior.work.originalTitle].some(t => normalizeTitle(t) === normalizeTitle(n)));
    if (same) return { ...prior, records: { ...prior.records, anilist: media } };
    const names = [media.title.english, media.title.romaji, media.title.native].filter(Boolean).slice(0, 3);
    const { anilist: _anilist, ...otherIds } = request.externalIds;
    const mapped = await again({ ...request, externalIds: otherIds, names: names.map(n => [n, media.startDate?.year].filter(value => value != null).join(" ")), kindHint: kind });
    if (mapped.status === "identified") return { ...mapped, records: { ...mapped.records, anilist: media } };
    return { status: "identified", records: { anilist: media }, work: { source: "anilist", anilistId: media.id, anime: true, animeFormat: media.format,
      kind, title: media.title.english || media.title.romaji || media.title.native, originalTitle: media.title.native,
      year: media.startDate?.year ?? null, seasons: [], poster: null, backdrop: null } };
  }

  /** One AniList record by its id, or `null` when AniList holds none. */
  async #byId(id) {
    return this.#ask(`id|${id}`, BY_ID, { id }, (data) => (data?.Media === undefined ? undefined : data.Media ?? null), "lookup");
  }

  async #search(title) {
    return this.#ask(title, QUERY, { search: title, page: 1 }, (data) => (Array.isArray(data?.Page?.media)
      ? { media: data.Page.media, incomplete: data.Page.pageInfo?.hasNextPage !== false }
      : undefined), "search");
  }

  /**
   * One cached, shared, gated AniList question.
   *
   * @param {string} key
   * @param {string} query
   * @param {object} variables
   * @param {(data: object) => unknown} extract - `undefined` when the answer is incomplete.
   * @param {string} what - Named in the refusals.
   */
  async #ask(key, query, variables, extract, what) {
    const cached = await this.#cache.get(key);
    if (cached !== undefined) return cached;
    if (this.#pending.has(key)) return this.#pending.get(key);
    const pending = this.#gate.run(async () => {
      let response;
      try {
        response = await this.#fetch("https://graphql.anilist.co", {
          method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({ query, variables }), signal: AbortSignal.timeout(4000)
        });
      } catch (cause) { throw new MetadataUnavailableError("AniList did not answer", { cause }); }
      if (response.status === 429 || response.headers.get("x-ratelimit-remaining") === "0") {
        const retry = Number(response.headers.get("retry-after"));
        this.#gate.pause(Date.now() + (retry > 0 ? retry : 60) * 1000);
      }
      // A record AniList does not hold is an answer about the id.
      if (what === "lookup" && response.status === 404) {
        await this.#cache.set(key, null, 60 * 60 * 1000);
        return null;
      }
      if (!response.ok) throw new MetadataUnavailableError(`AniList refused the ${what}`, { cause: await providerResponseError(response) });
      let body;
      try { body = JSON.parse((await readBoundedBody(response, 128 * 1024)).toString("utf8")); }
      catch (cause) { throw new MetadataUnavailableError("AniList returned invalid data", { cause }); }
      const result = body.errors ? undefined : extract(body.data);
      if (result === undefined) {
        const cause = new Error(`AniList ${what} was incomplete`);
        cause.providerMessage = JSON.stringify(body.errors ?? []);
        throw new MetadataUnavailableError(`AniList ${what} was incomplete`, { cause });
      }
      await this.#cache.set(key, result, 60 * 60 * 1000);
      return result;
    }, { deadlineAt: Date.now() + 10_000 });
    this.#pending.set(key, pending);
    try { return await pending; } finally { this.#pending.delete(key); }
  }
}