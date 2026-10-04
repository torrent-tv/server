/**
 * @file What the page asks about a release: which work it is, and which
 * episode of that work each file of one season is.
 *
 * Owns the order of questions and nothing else. Searches, works and seasons are
 * cached and shared between browsers; the identification itself is not cached,
 * because it is recomputed from cached searches in microseconds and a cache of
 * it would be a second copy of the same answer keyed differently.
 *
 * **Cache keys hold every parameter that changes the answer.** A search is
 * keyed by kind, language and the exact query sent — the query is sent without
 * a year, so the year cannot change what the provider returns, and is applied
 * afterwards by {@link decideIdentity}. A work by kind, id and language; a
 * season by id, number and language.
 *
 * **What the server does not keep.** Names and file lists arrive in a request
 * and leave with its answer. They are not stored and not logged: the log line
 * carries counts and outcomes only.
 */

import { decideByAlternativeTitles, decideByEpisodeTitles, decideIdentity, resultYearAgrees } from "./identification.js";
import { matchSeason } from "./episode-match.js";
import { parseReleaseName } from "./release-name.js";
import { MetadataUnavailableError } from "./RequestGate.js";
import { normalizeTitle } from "./title.js";
import { matchesRussianTransliteration, russianSearchSpellings, russianTitleSpellings } from "./russian-transliteration.js";

/** How long one browser request may take, including its waits. A stated limit. */
const REQUEST_BUDGET_MS = 4_000;

/** How long one shared fetch may run; longer than a request, so its answer can reach the cache. */
const FETCH_BUDGET_MS = 8_000;

/** Pages of one search read. Beyond this a single match is `undetermined`. A stated limit. */
const MAX_SEARCH_PAGES = 3;

/** Distinct spellings searched per identification. A stated limit. */
const MAX_QUERIES = 12;

/** Results checked by their episode names when no title matched. A stated limit. */
const MAX_EPISODE_CHECKS = 5;

/** Results checked by their alternative titles when no title matched. A stated limit. */
const MAX_ALTERNATIVE_CHECKS = 5;

/**
 * The answer of the alternative-title stage joined with the episode stage's.
 * Episodes settle what the alternative titles left open: when those named two
 * works, a series identified by its episodes is taken only if it is one of
 * them, and a different one leaves the answer ambiguous. An episode stage that
 * found nothing keeps the earlier answer, so results left unchecked there stay
 * undetermined.
 *
 * @param {import("./identification.js").Identity} byAlternative
 * @param {import("./identification.js").Identity} byEpisodes
 * @returns {import("./identification.js").Identity}
 */
function combineStages(byAlternative, byEpisodes) {
  if (byAlternative.status === "ambiguous") {
    const [found] = byEpisodes.status === "identified" ? byEpisodes.candidates : [];
    const among = found && byAlternative.candidates.some((candidate) => candidate.kind === found.kind && candidate.tmdbId === found.tmdbId);
    return among ? byEpisodes : byAlternative;
  }
  return byEpisodes.status === "not-found" ? byAlternative : byEpisodes;
}

/** How long a found work, season or non-empty search is kept. */
const FOUND_TTL_MS = 24 * 60 * 60 * 1000;

/** How long a search that found nothing is kept — short, because the provider grows. */
const NOTHING_TTL_MS = 60 * 60 * 1000;

/**
 * @typedef {object} IdentifyRequest
 * @property {string[]} names
 * @property {"tv" | "movie" | null} kindHint
 * @property {boolean} [requireYear] - Identify only when a name states a year:
 *   for one picture of a release not known to be one work, where a bare title
 *   (a performer's folder, a file called `01`) says too little.
 * @property {{ season: number, titles: string[] } | null} [episodeEvidence] - The
 *   titles one season of the release's files carry, used only when no title
 *   matched; see {@link decideByEpisodeTitles}.
 * @property {string} language
 * @property {AbortSignal} [signal]
 */

export class MetadataService {
  /** @type {import("./TmdbSource.js").TmdbSource | null} */
  #source;

  /** @type {import("./MetadataCache.js").MetadataCache} */
  #cache;

  /** @type {import("./SharedFetches.js").SharedFetches} */
  #fetches;

  /** @type {() => number} */
  #now;

  /**
   * @param {object} params
   * @param {import("./TmdbSource.js").TmdbSource | null} params.source - `null` when no token is configured.
   * @param {import("./MetadataCache.js").MetadataCache} params.cache
   * @param {import("./SharedFetches.js").SharedFetches} params.fetches
   * @param {() => number} [params.now]
   */
  constructor({ source, cache, fetches, now = Date.now }) {
    this.#source = source;
    this.#cache = cache;
    this.#fetches = fetches;
    this.#now = now;
  }

  /**
   * Which work these names identify.
   *
   * @param {IdentifyRequest} request
   * @returns {Promise<{ status: string, work?: import("./TmdbSource.js").Work, candidates?: object[] }>}
   */
  /** A bounded last resort, called only after both providers found no identity. */
  async identifyTransliterated({ names, kindHint, subtitleEvidence = null, language, signal }) {
    if (!this.#source) return { status: "unavailable" };
    const readings = names.map(parseReleaseName);
    const years = [...new Set([...readings.map(reading => reading.years?.from), ...(subtitleEvidence?.years ?? [])].filter(Number.isInteger))];
    if (years.length > 1) return { status: "not-found" };
    const titles = [...new Set(readings.flatMap(reading => reading.titles).map(normalizeTitle))];
    const latin = titles.filter(title => /^[a-z0-9 ]+$/u.test(title));
    const words = [...new Set(latin.flatMap(title => title.split(" ")).filter(word => /^[a-z]{5,}$/u.test(word)))];
    if (!words.length) return { status: "not-found" };
    if (words.length > 3) return { status: "undetermined" };
    const expanded = [...new Set(words.flatMap(word => [word, ...russianSearchSpellings(word)]))];
    const wordDiscovery = expanded.length <= MAX_QUERIES ? expanded : words;
    const wholeDiscovery = [...new Set(latin.flatMap(russianTitleSpellings))];
    const stages = [wholeDiscovery.length <= MAX_QUERIES ? wholeDiscovery : [], wordDiscovery];
    const kinds = kindHint ? [kindHint] : readings.some(reading => reading.seriesEvidence) ? ["tv"] : ["tv", "movie"];
    const wait = { deadlineAt: this.#now() + REQUEST_BUDGET_MS, signal };
    try {
      for (const discovery of stages) {
        if (!discovery.length) continue;
      const candidates = new Map();
      for (const kind of kinds) {
        for (const word of discovery) {
          const found = await this.#search(kind, word, language, wait);
          if (found.capped) return { status: "undetermined" };
          for (const candidate of found.results) {
            if (!years.length || candidate.year === years[0]) candidates.set(`${kind}|${candidate.id}`, { ...candidate, kind });
          }
        }
      }
      if (candidates.size > MAX_ALTERNATIVE_CHECKS) return { status: "undetermined" };
      const matches = [];
      for (const candidate of candidates.values()) {
        const russian = await this.#cached(`work|${candidate.kind}|${candidate.id}|ru-RU`, () => FOUND_TTL_MS,
          deadlineAt => this.#source.work(candidate.kind, candidate.id, "ru-RU", { deadlineAt }), wait);
        if (years.length && russian.year !== years[0]) continue;
        const aliases = await this.#cached(`alternative|${candidate.kind}|${candidate.id}`, () => FOUND_TTL_MS,
          deadlineAt => this.#source.alternativeTitles(candidate.kind, candidate.id, { deadlineAt }), wait);
        const catalogTitles = [candidate.name, candidate.originalName, russian.title, russian.originalTitle, ...aliases].filter(Boolean);
        const agrees = title => catalogTitles.some(alias => normalizeTitle(title) === normalizeTitle(alias) || matchesRussianTransliteration(title, alias));
        if (!latin.some(agrees)) continue;
        if (subtitleEvidence?.titles?.some(title => !agrees(title))) continue;
        matches.push(candidate);
      }
      if (!matches.length) continue;
      if (matches.length !== 1) return { status: "ambiguous" };
      const [chosen] = matches;
      const work = await this.#cached(`work|${chosen.kind}|${chosen.id}|${language}`, () => FOUND_TTL_MS,
        deadlineAt => this.#source.work(chosen.kind, chosen.id, language, { deadlineAt }), wait);
      return { status: "identified", work };
      }
      return { status: "not-found" };
    } catch (error) {
      if (error instanceof MetadataUnavailableError) return { status: "unavailable" };
      throw error;
    }
  }

  async identify({ names, kindHint, requireYear = false, episodeEvidence = null, language, signal }) {
    if (episodeEvidence) {
      episodeEvidence = { ...episodeEvidence, titles: episodeEvidence.titles.filter(title => parseReleaseName(title).titles.length > 0) };
      if (!episodeEvidence.titles.length) episodeEvidence = null;
    }
    if (!this.#source) {
      return { status: "unavailable" };
    }
    const deadlineAt = this.#now() + REQUEST_BUDGET_MS;
    const readings = names.map(parseReleaseName);
    const seriesEvidence = readings.some((reading) => reading.seriesEvidence);
    const kinds = kindHint ? [kindHint] : seriesEvidence ? ["tv"] : ["tv", "movie"];
    const statedYears = [...new Set(readings.map((reading) => reading.years?.from).filter(Number.isInteger))];
    // Measured 2026-09-30: one picture of an adult pack, under a folder named
    // after a performer, matched a film of that name. Without a stated year a
    // bare title is not enough when nothing says the picture is a film at all.
    if (requireYear && statedYears.length === 0) {
      return { status: "undetermined" };
    }

    // What is SENT is the spelling as written, apostrophes made plain: a
    // provider's own search may not find `christies` for `Christie's`. What is
    // COMPARED is the normalized form. One spelling per normalized form, so two
    // spellings of one title do not cost two searches.
    const queries = [];
    const seen = new Set();
    const addQuery = (text) => {
      const sent = String(text).replace(/[`´ʼ’‘]/g, "'").replace(/\s+/g, " ").trim();
      const normalized = normalizeTitle(sent);
      if (normalized.length >= 2 && !seen.has(normalized) && queries.length < MAX_QUERIES) {
        seen.add(normalized);
        queries.push({ sent, normalized });
      }
    };
    for (const reading of readings) {
      for (const title of reading.titles) {
        addQuery(title);
        // `Firefly 1 - LostFilm.TV` numbers the season after the title. Only
        // when a series is being looked for: for a film the number is part of
        // the title (`Moana 2`).
        if (kinds.includes("tv") && /\s\d{1,2}$/.test(title.trim())) {
          addQuery(title.trim().replace(/\s\d{1,2}$/, ""));
        }
      }
    }
    if (queries.length === 0) {
      return { status: "not-found" };
    }

    const searches = await Promise.all(
      queries.flatMap(({ sent, normalized }) =>
        kinds.map(async (kind) => {
          try {
            const found = await this.#search(kind, sent, language, { deadlineAt, signal });
            return { kind, query: normalized, status: found.capped ? "capped" : "complete", results: found.results };
          } catch (error) {
            if (error instanceof MetadataUnavailableError) {
              return { kind, query: normalized, status: "failed", results: [] };
            }
            throw error;
          }
        })
      )
    );

    let identity = decideIdentity({ searches, statedYears });
    // No main or original title matched. Two further stages, each only among
    // results a stated year admits — without one the set is every work of that
    // name, and a remake shares its alternative titles and its episode titles:
    // the provider's alternative titles (a transliterated or romanized name),
    // and, for a series, its episodes.
    if (identity.status === "not-found" && statedYears.length > 0) {
      try {
        const byAlternative = await this.#identifyByAlternativeTitles({
          searches,
          statedYears,
          queries: queries.map((query) => query.normalized),
          deadlineAt,
          signal
        });
        identity = byAlternative;
        if (byAlternative.status !== "identified" && kinds.includes("tv") && episodeEvidence) {
          const byEpisodes = await this.#identifyByEpisodes({ searches, statedYears, episodeEvidence, language, deadlineAt, signal });
          identity = combineStages(byAlternative, byEpisodes);
        }
      } catch (error) {
        if (error instanceof MetadataUnavailableError) {
          return { status: "unavailable" };
        }
        throw error;
      }
    }
    if (identity.status !== "identified") {
      return { status: identity.status, candidates: identity.status === "ambiguous" ? identity.candidates : undefined };
    }
    const [chosen] = identity.candidates;
    try {
      const work = await this.#cached(`work|${chosen.kind}|${chosen.tmdbId}|${language}`, () => FOUND_TTL_MS, (fetchDeadline) =>
        this.#source.work(chosen.kind, chosen.tmdbId, language, { deadlineAt: fetchDeadline }), { deadlineAt, signal });
      return { status: "identified", work };
    } catch (error) {
      if (error instanceof MetadataUnavailableError) {
        return { status: "unavailable" };
      }
      throw error;
    }
  }

  /**
   * The alternative-title stage of {@link identify}: the first results a
   * stated year admits, of every kind searched, each checked for a searched
   * spelling among its alternative titles.
   *
   * @param {object} params
   * @returns {Promise<import("./identification.js").Identity>}
   */
  async #identifyByAlternativeTitles({ searches, statedYears, queries, deadlineAt, signal }) {
    const admitted = [];
    const seen = new Set();
    for (const search of searches) {
      for (const result of search.results) {
        const key = `${search.kind}:${result.id}`;
        if (!seen.has(key) && resultYearAgrees(result.year, statedYears)) {
          seen.add(key);
          admitted.push({ kind: search.kind, result });
        }
      }
    }
    const toCheck = admitted.slice(0, MAX_ALTERNATIVE_CHECKS);
    const checked = await Promise.all(
      toCheck.map(async ({ kind, result }) => ({
        candidate: { kind, tmdbId: result.id, title: result.name, year: result.year },
        titles: await this.#cached(
          `alternative|${kind}|${result.id}`,
          () => FOUND_TTL_MS,
          (fetchDeadline) => this.#source.alternativeTitles(kind, result.id, { deadlineAt: fetchDeadline }),
          { deadlineAt, signal }
        )
      }))
    );
    return decideByAlternativeTitles({ checked, queries, uncheckedRemain: admitted.length > toCheck.length });
  }

  /**
   * The episode stage of {@link identify}: the first results a stated year
   * admits, each checked against the files' titles for one season.
   *
   * @param {object} params
   * @returns {Promise<import("./identification.js").Identity>}
   */
  async #identifyByEpisodes({ searches, statedYears, episodeEvidence, language, deadlineAt, signal }) {
    const admitted = [];
    const seen = new Set();
    for (const search of searches) {
      if (search.kind !== "tv") {
        continue;
      }
      for (const result of search.results) {
        if (!seen.has(result.id) && resultYearAgrees(result.year, statedYears)) {
          seen.add(result.id);
          admitted.push(result);
        }
      }
    }
    const toCheck = admitted.slice(0, MAX_EPISODE_CHECKS);
    const checked = await Promise.all(
      toCheck.map(async (result) => {
        const season = await this.#cached(
          `season|${result.id}|${episodeEvidence.season}|${language}`,
          () => FOUND_TTL_MS,
          (fetchDeadline) => this.#source.season(result.id, episodeEvidence.season, language, { deadlineAt: fetchDeadline }),
          { deadlineAt, signal }
        ).catch((error) => {
          // A season the show does not have is an answer, not a refusal.
          if (error instanceof MetadataUnavailableError && / 404$/.test(error.reason)) {
            return { number: episodeEvidence.season, name: "", episodes: [] };
          }
          throw error;
        });
        return {
          candidate: { kind: "tv", tmdbId: result.id, title: result.name, year: result.year },
          episodeNames: season.episodes.map((episode) => episode.name)
        };
      })
    );
    return decideByEpisodeTitles({
      checked,
      titles: episodeEvidence.titles,
      uncheckedRemain: admitted.length > toCheck.length
    });
  }

  /**
   * Which episode of one season each file is.
   *
   * @param {object} request
   * @param {number} request.tmdbId
   * @param {number} request.season
   * @param {string} request.language
   * @param {import("./episode-match.js").ReleaseFile[]} request.files - Every file of the season.
   * @param {AbortSignal} [request.signal]
   * @returns {Promise<{ status: string, season?: { number: number, name: string }, files?: import("./episode-match.js").FileMatch[] }>}
   */
  async episodes({ tmdbId, season, language, files, signal }) {
    if (!this.#source) {
      return { status: "unavailable" };
    }
    const deadlineAt = this.#now() + REQUEST_BUDGET_MS;
    let seasonData;
    try {
      seasonData = await this.#cached(`season|${tmdbId}|${season}|${language}`, () => FOUND_TTL_MS, (fetchDeadline) =>
        this.#source.season(tmdbId, season, language, { deadlineAt: fetchDeadline }), { deadlineAt, signal });
    } catch (error) {
      if (error instanceof MetadataUnavailableError) {
        return { status: "unavailable" };
      }
      throw error;
    }
    return {
      status: "matched-season",
      season: { number: seasonData.number, name: seasonData.name },
      files: matchSeason(files, seasonData)
    };
  }

  /**
   * One search, every page up to the limit, as one cached answer.
   *
   * @param {"tv" | "movie"} kind
   * @param {string} query
   * @param {string} language
   * @param {{ deadlineAt: number, signal?: AbortSignal }} wait
   * @returns {Promise<{ results: import("./TmdbSource.js").SearchResult[], capped: boolean }>}
   */
  #search(kind, query, language, wait) {
    return this.#cached(
      `search|${kind}|${language}|${query}`,
      (found) => (found.results.length > 0 ? FOUND_TTL_MS : NOTHING_TTL_MS),
      async (fetchDeadline) => {
        const first = await this.#source.search(kind, query, language, 1, { deadlineAt: fetchDeadline });
        const results = [...first.results];
        const lastPage = Math.min(first.totalPages, MAX_SEARCH_PAGES);
        for (let page = 2; page <= lastPage; page += 1) {
          const next = await this.#source.search(kind, query, language, page, { deadlineAt: fetchDeadline });
          results.push(...next.results);
        }
        return { results, capped: first.totalPages > MAX_SEARCH_PAGES };
      },
      wait
    );
  }

  /**
   * The cached answer to `key`, or one shared fetch of it.
   *
   * @template T
   * @param {string} key
   * @param {(value: T) => number} ttlFor
   * @param {(fetchDeadlineAt: number) => Promise<T>} fetch
   * @param {{ deadlineAt: number, signal?: AbortSignal }} wait
   * @returns {Promise<T>}
   */
  async #cached(key, ttlFor, fetch, wait) {
    const held = await this.#cache.get(key);
    if (held !== undefined) {
      return /** @type {T} */ (held);
    }
    return this.#fetches.join(
      key,
      async () => {
        const cached = await this.#cache.get(key);
        if (cached !== undefined) return cached;
        const value = await fetch(this.#now() + FETCH_BUDGET_MS);
        // Work records and their titles change slowly. Search results and
        // season inventories keep their shorter refresh interval.
        const ttl = /^(work|alternative)\|/u.test(key) ? 7 * FOUND_TTL_MS : ttlFor(value);
        await this.#cache.set(key, value, ttl);
        return value;
      },
      { ...wait, now: this.#now }
    );
  }
}
