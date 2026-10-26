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

import { decideByAlternativeTitles, decideByEpisodeTitles, decideIdentity, preferYearMatches } from "./identification.js";
import { rankCandidates } from "./candidate-score.js";
import { matchSeason } from "./episode-match.js";
import { parseReleaseName } from "./release-name.js";
import { MetadataUnavailableError } from "./RequestGate.js";
import { providerFailure } from "./provider-diagnostics.js";
import { normalizeTitle } from "./title.js";
import { matchesRussianTransliteration, russianLookalikeTitle, russianSearchSpellings, russianTitleSpellings } from "./russian-transliteration.js";

/** Base request budget when scoring needs no supplemental catalogue evidence. */
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

/** Expanded discovery only when a measured file duration can distinguish titles. */
const MAX_RUNTIME_SEARCH_PAGES = 20;
const MAX_RUNTIME_CHECKS = 60;
/** Extended budget for reading supplemental evidence across the candidate set. */
const EVIDENCE_REQUEST_BUDGET_MS = 20_000;

/**
 * Candidates whose record is read when no supplemental fact can distinguish
 * them. Evidence-bearing requests inspect up to MAX_RUNTIME_CHECKS candidates.
 */
const MAX_INITIAL_RECORD_CHECKS = 8;

/** Candidate feature values returned so the survey can replay the ranking. */
const MAX_RANKED_REPORTED = MAX_RUNTIME_CHECKS;

/** Search results retained with an identification answer. */
const MAX_SEARCH_RESULTS_REPORTED = MAX_RUNTIME_CHECKS;
const MAX_DIAGNOSTIC_CANDIDATES = 60;

function boundedText(value, limit = 200) {
  return typeof value === "string" ? value.slice(0, limit) : null;
}

/** Search in the language of the release spelling, independently of display. */
function searchLanguageOf(title) {
  return /\p{Script=Cyrillic}/u.test(title) ? "ru-RU" : "en-US";
}

function candidateEvidence(searches) {
  const candidates = new Map();
  let truncated = 0;
  for (const search of searches) {
    for (const result of search.results ?? []) {
      const key = `${search.kind}:${result.id}`;
      let candidate = candidates.get(key);
      if (!candidate) {
        if (candidates.size >= MAX_DIAGNOSTIC_CANDIDATES) {
          truncated += 1;
          continue;
        }
        candidate = {
          kind: search.kind,
          tmdbId: result.id,
          title: boundedText(result.name),
          originalTitle: boundedText(result.originalName),
          year: result.year,
          admissions: [],
          admissionsTruncated: false
        };
        candidates.set(key, candidate);
      }
      const name = normalizeTitle(result.name);
      const originalName = normalizeTitle(result.originalName);
      const admission = name === search.query || originalName === search.query
        ? "exact"
        : name.startsWith(`${search.query} `) || originalName.startsWith(`${search.query} `) ? "prefix" : "rejected";
      if (candidate.admissions.length < 12) candidate.admissions.push({ query: boundedText(search.query), status: search.status, admission });
      else candidate.admissionsTruncated = true;
    }
  }
  return { candidates: [...candidates.values()], truncated, limit: MAX_DIAGNOSTIC_CANDIDATES };
}

function reportedRanked(ranked) {
  return ranked.slice(0, MAX_RANKED_REPORTED).map(({ kind, tmdbId, title, year, titleMatch, shares, score, contradiction, order }) =>
    ({ kind, tmdbId, title: boundedText(title), year, titleMatch, shares, score, contradiction, order }));
}

function reportedSearches(searches) {
  return searches.map(({ kind, query, language, status, results, pagesFetched, totalPages }) => ({
    provider: "tmdb",
    kind,
    query,
    language,
    status,
    pagesFetched,
    totalPages,
    totalResults: results.length,
    truncated: results.length > MAX_SEARCH_RESULTS_REPORTED,
    results: results.slice(0, MAX_SEARCH_RESULTS_REPORTED)
  }));
}

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
  if (byEpisodes.status === "identified") return byEpisodes;
  if (byEpisodes.status === "not-found" || (byAlternative.status === "identified" && byEpisodes.incomplete)) return byAlternative;
  return byEpisodes;
}

/** How long a found work, season or non-empty search is kept. */
const FOUND_TTL_MS = 24 * 60 * 60 * 1000;

/** How long a search that found nothing is kept — short, because the provider grows. */
const NOTHING_TTL_MS = 60 * 60 * 1000;

/**
 * @typedef {object} IdentifyRequest
 * @property {string[]} names
 * @property {"tv" | "movie" | null} kindHint
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
    const diagnostics = { mode: "transliteration", searches: [], candidates: [], checked: [], selection: null };
    if (!this.#source) return { status: "unavailable", diagnostics };
    const readings = names.map(parseReleaseName);
    const years = [...new Set([...readings.map(reading => reading.years?.from), ...(subtitleEvidence?.years ?? [])].filter(Number.isInteger))];
    const titles = [...new Set(readings.flatMap(reading => reading.titles).map(normalizeTitle))];
    const latin = titles.filter(title => /^[a-z0-9 ]+$/u.test(title));
    const words = [...new Set(latin.flatMap(title => title.split(" ")).filter(word => /^[a-z]{5,}$/u.test(word)))];
    if (!words.length) {
      diagnostics.selection = { status: "not-found", reason: "no-transliterated-search-word" };
      return { status: "not-found", diagnostics };
    }
    if (words.length > 3) {
      diagnostics.selection = { status: "undetermined", reason: "word-count-limit", wordsAvailable: words.length, wordsAllowed: 3 };
      return { status: "undetermined", diagnostics };
    }
    const expanded = [...new Set(words.flatMap(word => [word, ...russianSearchSpellings(word)]))];
    const wordDiscovery = expanded.length <= MAX_QUERIES ? expanded : words;
    const wholeDiscovery = [...new Set(latin.flatMap(russianTitleSpellings))];
    const stages = [wholeDiscovery.length <= MAX_QUERIES ? wholeDiscovery : [], wordDiscovery];
    const kinds = kindHint ? [kindHint] : readings.some(reading => reading.seriesEvidence) ? ["tv"] : ["tv", "movie"];
    const wait = { deadlineAt: this.#now() + REQUEST_BUDGET_MS, signal };
    const allCandidates = new Map();
    try {
      for (const [stageIndex, discovery] of stages.entries()) {
        const stageName = stageIndex === 0 ? "whole-title-spelling" : "word-spellings";
        if (!discovery.length) {
          (diagnostics.stages ??= []).push({ name: stageName, status: "skipped", reason: "query-count-limit" });
          continue;
        }
      const candidates = new Map();
      for (const kind of kinds) {
        for (const word of discovery) {
          const found = await this.#search(kind, word, language, wait);
          diagnostics.searches.push({ kind, query: boundedText(word), language, status: found.capped ? "capped" : "complete",
            returned: found.results.length, pagesFetched: found.pagesFetched, totalPages: found.totalPages });
          for (const candidate of found.results) {
            candidates.set(`${kind}|${candidate.id}`, { ...candidate, kind });
            allCandidates.set(`${kind}|${candidate.id}`, { ...candidate, kind });
          }
          if (found.capped) {
            (diagnostics.stages ??= []).push({ name: stageName, status: "undetermined", reason: "search-page-limit", candidatesAvailable: candidates.size });
            diagnostics.selection = { status: "undetermined", reason: "search-page-limit", candidatesAvailable: candidates.size };
            diagnostics.candidates = [...allCandidates.values()].slice(0, MAX_DIAGNOSTIC_CANDIDATES).map(candidate => ({
              kind: candidate.kind, tmdbId: candidate.id, title: boundedText(candidate.name), originalTitle: boundedText(candidate.originalName), year: candidate.year
            }));
            diagnostics.candidatesTruncated = allCandidates.size > MAX_DIAGNOSTIC_CANDIDATES;
            return { status: "undetermined", diagnostics };
          }
        }
      }
      diagnostics.candidatesAvailable = allCandidates.size;
      diagnostics.candidates = [...allCandidates.values()].slice(0, MAX_DIAGNOSTIC_CANDIDATES).map(candidate => ({
        kind: candidate.kind, tmdbId: candidate.id, title: boundedText(candidate.name), originalTitle: boundedText(candidate.originalName), year: candidate.year
      }));
      diagnostics.candidatesTruncated = allCandidates.size > MAX_DIAGNOSTIC_CANDIDATES;
      if (candidates.size > MAX_ALTERNATIVE_CHECKS) {
        (diagnostics.stages ??= []).push({ name: stageName, status: "undetermined", reason: "alternative-check-limit", candidatesAvailable: candidates.size });
        diagnostics.selection = { status: "undetermined", reason: "alternative-check-limit", candidatesAvailable: candidates.size, candidatesAllowed: MAX_ALTERNATIVE_CHECKS };
        return { status: "undetermined", diagnostics };
      }
      const matches = [];
      for (const candidate of candidates.values()) {
        const checked = { kind: candidate.kind, tmdbId: candidate.id, title: boundedText(candidate.name), status: "checking", recordReads: [] };
        diagnostics.checked.push(checked);
        let russian;
        try {
          russian = await this.#cached(`work|v3|${candidate.kind}|${candidate.id}|ru-RU`, () => FOUND_TTL_MS,
            deadlineAt => this.#source.work(candidate.kind, candidate.id, "ru-RU", { deadlineAt }), wait);
          checked.recordReads.push({ language: "ru-RU", status: "read" });
        } catch (error) {
          if (!(error instanceof MetadataUnavailableError)) throw error;
          checked.recordReads.push({ language: "ru-RU", status: "failed" });
          throw error;
        }
        let aliases;
        try {
          aliases = await this.#cached(`alternative|${candidate.kind}|${candidate.id}`, () => FOUND_TTL_MS,
            deadlineAt => this.#source.alternativeTitles(candidate.kind, candidate.id, { deadlineAt }), wait);
          checked.recordReads.push({ record: "alternative-titles", status: "read" });
        } catch (error) {
          if (!(error instanceof MetadataUnavailableError)) throw error;
          checked.recordReads.push({ record: "alternative-titles", status: "failed" });
          throw error;
        }
        const catalogTitles = [candidate.name, candidate.originalName, russian.title, russian.originalTitle, ...aliases].filter(Boolean);
        const agrees = title => catalogTitles.some(alias => normalizeTitle(title) === normalizeTitle(alias) || matchesRussianTransliteration(title, alias));
        checked.matchedReleaseTitles = latin.filter(agrees).slice(0, 12).map(title => boundedText(title));
        checked.subtitleTitlesAgree = !subtitleEvidence?.titles?.some(title => !agrees(title));
        checked.status = checked.matchedReleaseTitles.length && checked.subtitleTitlesAgree ? "admitted" : "rejected";
        if (checked.status !== "admitted") continue;
        matches.push(candidate);
      }
      if (!matches.length) {
        diagnostics.stages ??= [];
        diagnostics.stages.push({ name: stageName, status: "not-found", candidatesAvailable: candidates.size, candidatesChecked: diagnostics.checked.length });
        continue;
      }
      const found = preferYearMatches(matches, years);
      if (found.length !== 1) {
        (diagnostics.stages ??= []).push({ name: stageName, status: "ambiguous", candidatesAvailable: matches.length, candidatesSelected: found.length });
        diagnostics.selection = { status: "ambiguous", reason: "multiple-transliteration-candidates", candidates: found.slice(0, MAX_ALTERNATIVE_CHECKS).map(candidate => ({ kind: candidate.kind, tmdbId: candidate.id })) };
        return { status: "ambiguous", diagnostics };
      }
      const [chosen] = found;
      let work;
      try {
        work = await this.#cached(`work|v3|${chosen.kind}|${chosen.id}|${language}`, () => FOUND_TTL_MS,
          deadlineAt => this.#source.work(chosen.kind, chosen.id, language, { deadlineAt }), wait);
        diagnostics.finalRecordRead = { kind: chosen.kind, tmdbId: chosen.id, language, status: "read" };
      } catch (error) {
        if (!(error instanceof MetadataUnavailableError)) throw error;
        diagnostics.finalRecordRead = { kind: chosen.kind, tmdbId: chosen.id, language, status: "failed" };
        throw error;
      }
      (diagnostics.stages ??= []).push({ name: stageName, status: "identified", candidatesAvailable: matches.length, candidatesSelected: 1 });
      diagnostics.selection = { status: "identified", kind: chosen.kind, tmdbId: chosen.id, reason: "one-transliterated-title-match" };
      return { status: "identified", work, diagnostics };
      }
      diagnostics.selection = { status: "not-found", reason: "all-transliteration-searches-complete" };
      return { status: "not-found", diagnostics };
    } catch (error) {
      if (error instanceof MetadataUnavailableError) {
        diagnostics.selection = { status: "unavailable", reason: "provider-or-record-read-failed" };
        return { status: "unavailable", diagnostics };
      }
      throw error;
    }
  }

  /**
   * Which work an id in another database names: a lookup, not a search. A
   * `TMDB` id is the work itself; an `IMDB` or `TVDB` id is found through
   * TMDB's "Find by ID". An id that names no work, or more than one, is
   * `not-found` and the search by name decides.
   *
   * @param {{ externalIds?: { imdb?: string, tmdb?: { kind: "movie" | "tv", id: number }, tvdb?: number }, language: string, signal?: AbortSignal }} request
   * @returns {Promise<{ status: string, work?: object }>}
   */
  async identifyById({ externalIds = {}, language, signal }) {
    if (!this.#source) return { status: "unavailable" };
    const wait = { deadlineAt: this.#now() + REQUEST_BUDGET_MS, signal };
    try {
      let chosen = externalIds.tmdb ? { kind: externalIds.tmdb.kind, id: externalIds.tmdb.id } : null;
      for (const [source, id] of [["imdb_id", externalIds.imdb], ["tvdb_id", externalIds.tvdb]]) {
        if (chosen || id === undefined) continue;
        const found = await this.#cached(`find|${source}|${id}`, (value) => (value.movie.length + value.tv.length > 0 ? FOUND_TTL_MS : NOTHING_TTL_MS),
          (deadlineAt) => this.#source.find(String(id), source, { deadlineAt }), wait);
        const all = [...found.movie.map((one) => ({ kind: "movie", id: one })), ...found.tv.map((one) => ({ kind: "tv", id: one }))];
        if (all.length === 1) chosen = all[0];
      }
      if (!chosen) return { status: "not-found" };
      const work = await this.#cached(`work|v3|${chosen.kind}|${chosen.id}|${language}`, () => FOUND_TTL_MS,
        (deadlineAt) => this.#source.work(chosen.kind, chosen.id, language, { deadlineAt }), wait);
      return { status: "identified", work: { ...work, identification: "external-id" } };
    } catch (error) {
      if (error instanceof MetadataUnavailableError) {
        // A TMDB id that does not exist is an answer about the id, not a refusal.
        return / 404$/u.test(error.reason ?? error.message ?? "") ? { status: "not-found" } : { status: "unavailable" };
      }
      throw error;
    }
  }

  async identify({ names, kindHint, episodeEvidence = null, durationSeconds = null, torrentCreatedAt = null, episodeNumbers = [], audioLanguages = [], statedYears: sourceYears = [], language, signal }) {
    if (episodeEvidence) {
      episodeEvidence = { ...episodeEvidence, titles: episodeEvidence.titles.filter(title => parseReleaseName(title).titles.length > 0) };
      if (!episodeEvidence.titles.length) episodeEvidence = null;
    }
    if (!this.#source) {
      return { status: "unavailable", diagnostics: { stages: [{ name: "search", status: "unavailable" }] } };
    }
    const hasDuration = Number.isFinite(durationSeconds) && durationSeconds > 0;
    const readings = names.map(parseReleaseName);
    const hasSupplementalEvidence = Boolean(hasDuration || episodeNumbers.length || audioLanguages.length || episodeEvidence ||
      readings.some((reading) => reading.titles.some((title) => /\p{Script=Cyrillic}/u.test(title))));
    const deadlineAt = this.#now() + (hasSupplementalEvidence ? EVIDENCE_REQUEST_BUDGET_MS : REQUEST_BUDGET_MS);
    const seriesEvidence = readings.some((reading) => reading.seriesEvidence);
    const kinds = kindHint ? [kindHint] : seriesEvidence ? ["tv"] : ["tv", "movie"];
    const statedYears = seriesEvidence ? [] : [...new Set([...readings.map((reading) => reading.years?.from), ...sourceYears].filter(Number.isInteger))];

    // What is SENT is the spelling as written, apostrophes made plain: a
    // provider's own search may not find `christies` for `Christie's`. What is
    // COMPARED is the normalized form. One spelling per normalized form, so two
    // spellings of one title do not cost two searches.
    const queries = [];
    const seen = new Set();
    const addQuery = (text) => {
      const sent = String(text).replace(/[`´ʼ’‘]/g, "'").replace(/\s+/g, " ").trim();
      const normalized = normalizeTitle(sent);
      if (normalized.length >= 2 && !/^\d+$/u.test(normalized) && !/^(?:stream|video ts|vts \d+)$/iu.test(normalized) &&
          !seen.has(normalized) && queries.length < MAX_QUERIES) {
        seen.add(normalized);
        queries.push({ sent, normalized, language: searchLanguageOf(sent) });
      }
    };
    for (const reading of readings) {
      for (const title of reading.titles) {
        addQuery(title);
        const russianTitle = russianLookalikeTitle(title);
        if (russianTitle) addQuery(russianTitle);
        // `Firefly 1 - LostFilm.TV` numbers the season after the title. Only
        // when a series is being looked for: for a film the number is part of
        // the title (`Moana 2`).
        if (kinds.includes("tv") && /\s\d{1,2}$/.test(title.trim())) {
          addQuery(title.trim().replace(/\s\d{1,2}$/, ""));
        }
      }
    }
    if (queries.length === 0) {
      return { status: "not-found", diagnostics: { stages: [{ name: "query", status: "not-found" }] } };
    }

    const searches = await Promise.all(
      queries.flatMap(({ sent, normalized, language: searchLanguage }) =>
        kinds.map(async (kind) => {
          try {
            const found = await this.#search(kind, sent, searchLanguage, { deadlineAt, signal }, hasDuration ? MAX_RUNTIME_SEARCH_PAGES : MAX_SEARCH_PAGES);
            return { kind, query: normalized, language: searchLanguage, status: found.capped ? "capped" : "complete", ...found };
          } catch (error) {
            if (error instanceof MetadataUnavailableError) {
              return { kind, query: normalized, language: searchLanguage, status: "failed", results: [], pagesFetched: 0, totalPages: null };
            }
            throw error;
          }
        })
      )
    );

    let identity = decideIdentity({ searches, candidateLimit: MAX_RUNTIME_CHECKS + 1 });
    const candidates = candidateEvidence(searches);
    const diagnostics = {
      limits: {
        maxQueries: MAX_QUERIES,
        maxPagesPerSearch: hasDuration ? MAX_RUNTIME_SEARCH_PAGES : MAX_SEARCH_PAGES,
        maxRuntimeChecks: MAX_RUNTIME_CHECKS,
        maxInitialRecordChecks: MAX_INITIAL_RECORD_CHECKS,
        maxAlternativeChecks: MAX_ALTERNATIVE_CHECKS,
        maxEpisodeChecks: MAX_EPISODE_CHECKS
      },
      searchCount: searches.length,
      searchOutcomes: searches.map(({ kind, query, language: searchLanguage, status, results, pagesFetched, totalPages }) => ({
        kind, query: boundedText(query), language: searchLanguage, status, returned: results.length, pagesFetched, totalPages
      })),
      candidates,
      stages: [{ name: "title", status: identity.status, candidateCount: identity.candidates.length,
        candidates: reportedRanked(identity.candidates.map(candidate => ({ ...candidate, score: null, contradiction: null }))) }],
      recordReads: [],
      ranking: [],
      selection: null
    };
    // Check provider aliases alongside any main-title match when the provider
    // returned records that did not qualify by their main or original title.
    // This keeps one unrelated exact match from hiding a supported alias.
    const hasRejectedSearchResults = searches.some(search => search.results.some(result => {
      const title = normalizeTitle(result.name);
      const original = normalizeTitle(result.originalName);
      return title !== search.query && original !== search.query &&
        !title.startsWith(`${search.query} `) && !original.startsWith(`${search.query} `);
    }));
    if (identity.status === "not-found" || identity.status === "undetermined" ||
        ((identity.status === "identified" || identity.status === "ambiguous") && hasRejectedSearchResults)) {
      try {
        const byAlternative = await this.#identifyByAlternativeTitles({
          searches,
          queries: queries.map((query) => query.normalized),
          statedYears,
          deadlineAt,
          signal
        });
        diagnostics.stages.push({ name: "alternative-title", status: byAlternative.status, ...byAlternative.diagnostics });
        if (byAlternative.candidates?.length) {
          const merged = new Map((identity.candidates ?? []).map(candidate => [`${candidate.kind}:${candidate.tmdbId}`, candidate]));
          let nextOrder = Math.max(-1, ...(identity.candidates ?? []).map(candidate => candidate.order)) + 1;
          for (const candidate of byAlternative.candidates) {
            const key = `${candidate.kind}:${candidate.tmdbId}`;
            if (!merged.has(key)) merged.set(key, { ...candidate, order: nextOrder++ });
          }
          const candidates = [...merged.values()].sort((left, right) => left.order - right.order);
          identity = { status: candidates.length > 1 ? "ambiguous" : "identified", candidates };
        } else if (identity.candidates?.length === 0) {
          identity = combineStages(identity, byAlternative);
        }
        if (byAlternative.status !== "identified" && kinds.includes("tv") && episodeEvidence) {
          const byEpisodes = await this.#identifyByEpisodes({ searches, episodeEvidence, language, deadlineAt, signal });
          diagnostics.stages.push({ name: "episode-title", status: byEpisodes.status, ...byEpisodes.diagnostics });
          identity = combineStages(identity, byEpisodes);
        }
      } catch (error) {
        if (error instanceof MetadataUnavailableError) {
          diagnostics.stages.push({ name: "alternative-title", status: "unavailable" });
          if (!identity.candidates?.length) {
            return { status: "unavailable", searches: reportedSearches(searches), diagnostics };
          }
        }
        else throw error;
      }
    }
    const pool = identity.candidates ?? [];
    if (pool.length === 0) {
      diagnostics.selection = { status: identity.status, candidate: null };
      return { status: identity.status, searches: reportedSearches(searches), diagnostics };
    }
    const highestEpisode = new Map();
    for (const { season, episode } of episodeNumbers) {
      highestEpisode.set(season, Math.max(highestEpisode.get(season) ?? 0, episode));
    }
    const russianTitles = [...new Set(readings.flatMap((reading) => reading.titles).filter((title) => /\p{Script=Cyrillic}/u.test(title)))];
    const releaseEpisodeCount = new Set(episodeNumbers.map(({ season, episode }) => `${season ?? "?"}:${episode}`)).size;
    const evidence = {
      statedYears,
      createdYear: Number.isFinite(torrentCreatedAt) && torrentCreatedAt > 0 ? new Date(torrentCreatedAt * 1000).getUTCFullYear() : null,
      series: episodeNumbers.length > 0,
      highestEpisode,
      releaseEpisodeCount,
      russianTitles,
      episodeTitles: episodeEvidence?.titles ?? [],
      episodeSeason: episodeEvidence?.season ?? null,
      durationSeconds: hasDuration ? durationSeconds : null,
      audioLanguages
    };
    // The records are read for the best by title and year first; with a
    // measured duration every candidate's runtime is worth reading.
    const recordLimit = hasDuration || (hasSupplementalEvidence && pool.length > 1) ? MAX_RUNTIME_CHECKS : MAX_INITIAL_RECORD_CHECKS;
    const read = rankCandidates(pool, new Map(), evidence).slice(0, recordLimit);
    diagnostics.recordLimit = recordLimit;
    diagnostics.recordCandidatesAvailable = pool.length;
    diagnostics.recordCandidatesRead = read.length;
    diagnostics.recordCandidatesTruncated = Math.max(0, pool.length - read.length);
    const { records, outcomes: recordReads } = await this.#records(read, { language, deadlineAt, signal, evidence });
    const ranked = rankCandidates(read, records, evidence);
    diagnostics.recordReads = recordReads;
    diagnostics.ranking = reportedRanked(ranked);
    const consistent = ranked.filter((candidate) => candidate.contradiction === null);
    if (consistent.length === 0) {
      diagnostics.selection = { status: "not-found", candidate: null, reason: "all-read-candidates-contradicted" };
      return {
        status: "not-found",
        searches: reportedSearches(searches),
        ranked: reportedRanked(ranked),
        diagnostics
      };
    }
    const [chosen] = consistent;
    try {
      const scoredWork = records.get(`${chosen.kind}:${chosen.tmdbId}`) ?? await this.#cached(`work|v3|${chosen.kind}|${chosen.tmdbId}|${language}`, () => FOUND_TTL_MS,
        (fetchDeadline) => this.#source.work(chosen.kind, chosen.tmdbId, language, { deadlineAt: fetchDeadline }), { deadlineAt, signal });
      const { russianTitle: _russianTitle, totalEpisodeCount: _totalEpisodeCount, episodeTitles: _episodeTitles, ...work } = scoredWork;
      diagnostics.selection = { status: "identified", candidate: { kind: chosen.kind, tmdbId: chosen.tmdbId, titleMatch: chosen.titleMatch }, reason: "highest-ranked-consistent-candidate" };
      return {
        status: "identified",
        work: { ...work, identification: pool.length > 1 ? "scored" : chosen.titleMatch },
        searches: reportedSearches(searches),
        ranked: reportedRanked(ranked),
        diagnostics
      };
    } catch (error) {
      if (error instanceof MetadataUnavailableError) {
        diagnostics.selection = { status: "unavailable", candidate: { kind: chosen.kind, tmdbId: chosen.tmdbId }, reason: "selected-record-read-failed" };
        return { status: "unavailable", searches: reportedSearches(searches), ranked: reportedRanked(ranked), diagnostics };
      }
      throw error;
    }
  }

  /**
   * The records of the candidates to be scored. A record the provider does not
   * answer is left out: the candidate is still scored, on what its search
   * result states.
   *
   * @param {Array<{ kind: "tv" | "movie", tmdbId: number }>} candidates
   * @param {{ language: string, deadlineAt: number, signal?: AbortSignal, evidence: object }} wait
   * @returns {Promise<Map<string, import("./TmdbSource.js").Work>>}
   */
  async #records(candidates, { language, deadlineAt, signal, evidence }) {
    const records = new Map();
    const outcomes = [];
    // Match source concurrency rather than filling its shared request queue.
    for (let offset = 0; offset < candidates.length; offset += 4) {
      await Promise.all(candidates.slice(offset, offset + 4).map(async (candidate) => {
        try {
          let work = await this.#cached(`work|v3|${candidate.kind}|${candidate.tmdbId}|${language}`, () => FOUND_TTL_MS,
            (fetchDeadline) => this.#source.work(candidate.kind, candidate.tmdbId, language, { deadlineAt: fetchDeadline }), { deadlineAt, signal });
          if (evidence.russianTitles?.length) {
            try {
              const russianTitle = await this.#cached(`title|${candidate.kind}|${candidate.tmdbId}|ru-RU`, () => FOUND_TTL_MS,
                (fetchDeadline) => this.#source.localizedTitle
                  ? this.#source.localizedTitle(candidate.kind, candidate.tmdbId, "ru-RU", { deadlineAt: fetchDeadline })
                  : this.#source.work(candidate.kind, candidate.tmdbId, "ru-RU", { deadlineAt: fetchDeadline }).then(translated => translated.title), { deadlineAt, signal });
              work = { ...work, russianTitle };
            } catch (error) {
              if (!(error instanceof MetadataUnavailableError)) throw error;
            }
          }
          if (candidate.kind === "tv") {
            work = { ...work, totalEpisodeCount: work.seasons.filter((season) => season.number > 0).reduce((sum, season) => sum + Math.max(0, season.episodeCount), 0) };
            if (evidence.episodeTitles?.length && Number.isInteger(evidence.episodeSeason)) {
              const episodeLanguage = evidence.episodeTitles.some((title) => /\p{Script=Cyrillic}/u.test(title)) ? "ru-RU" : language;
              try {
                const season = await this.#cached(`season|${candidate.tmdbId}|${evidence.episodeSeason}|${episodeLanguage}`, () => FOUND_TTL_MS,
                  (fetchDeadline) => this.#source.season(candidate.tmdbId, evidence.episodeSeason, episodeLanguage, { deadlineAt: fetchDeadline }), { deadlineAt, signal });
                work = { ...work, episodeTitles: season.episodes.map((episode) => episode.name) };
              } catch (error) {
                if (!(error instanceof MetadataUnavailableError)) throw error;
              }
            }
          }
          records.set(`${candidate.kind}:${candidate.tmdbId}`, work);
          outcomes.push({ kind: candidate.kind, tmdbId: candidate.tmdbId, status: "read" });
        } catch (error) {
          if (!(error instanceof MetadataUnavailableError)) throw error;
          outcomes.push({ kind: candidate.kind, tmdbId: candidate.tmdbId, status: "failed" });
        }
      }));
    }
    return { records, outcomes: outcomes.sort((left, right) => candidates.findIndex(candidate => candidate.tmdbId === left.tmdbId && candidate.kind === left.kind) -
      candidates.findIndex(candidate => candidate.tmdbId === right.tmdbId && candidate.kind === right.kind)) };
  }

  /**
   * The alternative-title stage of {@link identify}: bounded search results
   * of every kind searched, each checked for a searched
   * spelling among its alternative titles.
   *
   * @param {object} params
   * @returns {Promise<import("./identification.js").Identity>}
   */
  async #identifyByAlternativeTitles({ searches, queries, statedYears = [], deadlineAt, signal }) {
    const admitted = [];
    const seen = new Set();
    for (const search of searches) {
      for (const result of search.results) {
        const title = normalizeTitle(result.name);
        const original = normalizeTitle(result.originalName);
        if (title === search.query || original === search.query || title.startsWith(`${search.query} `) || original.startsWith(`${search.query} `)) {
          continue;
        }
        const key = `${search.kind}:${result.id}`;
        if (!seen.has(key)) {
          seen.add(key);
          admitted.push({ kind: search.kind, result, order: admitted.length });
        }
      }
    }
    // Check the most relevant returned-but-rejected results first. A release
    // year is useful for ordering catalogue reads, but never admits a result.
    admitted.sort((left, right) => {
      const distance = candidate => Number.isInteger(candidate.result.year) && statedYears.length
        ? Math.min(...statedYears.map(year => Math.abs(year - candidate.result.year))) : Infinity;
      return distance(left) - distance(right) || left.order - right.order;
    });
    const toCheck = admitted.slice(0, MAX_ALTERNATIVE_CHECKS);
    const checked = await Promise.all(
      toCheck.map(async ({ kind, result }) => ({
        candidate: { kind, tmdbId: result.id, title: result.name, year: result.year, order: admitted.findIndex((one) => one.result === result) },
        titles: await this.#cached(
          `alternative|${kind}|${result.id}`,
          () => FOUND_TTL_MS,
          (fetchDeadline) => this.#source.alternativeTitles(kind, result.id, { deadlineAt: fetchDeadline }),
          { deadlineAt, signal }
        )
      }))
    );
    const identity = decideByAlternativeTitles({ checked, queries, uncheckedRemain: admitted.length > toCheck.length });
    const checkedIds = new Set(identity.candidates.map(candidate => `${candidate.kind}:${candidate.tmdbId}`));
    return { ...identity,
      incomplete: admitted.length > toCheck.length || searches.some(search => search.status !== "complete"),
      diagnostics: {
        candidatesAvailable: admitted.length,
        candidatesChecked: checked.length,
        candidatesTruncated: Math.max(0, admitted.length - toCheck.length),
        checked: checked.slice(0, MAX_ALTERNATIVE_CHECKS).map(({ candidate, titles }) => ({
          kind: candidate.kind,
          tmdbId: candidate.tmdbId,
          title: boundedText(candidate.title),
          status: checkedIds.has(`${candidate.kind}:${candidate.tmdbId}`) ? "admitted" : "rejected",
          matchedQueries: queries.filter(query => titles.some(title => normalizeTitle(title) === query)).slice(0, 12)
        }))
      }
    };
  }

  /**
   * The episode stage of {@link identify}: bounded search results, each
   * checked against the files' titles for one season.
   *
   * @param {object} params
   * @returns {Promise<import("./identification.js").Identity>}
   */
  async #identifyByEpisodes({ searches, episodeEvidence, language, deadlineAt, signal }) {
    const admitted = [];
    const seen = new Set();
    for (const search of searches) {
      if (search.kind !== "tv") {
        continue;
      }
      for (const result of search.results) {
        if (!seen.has(result.id)) {
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
          candidate: { kind: "tv", tmdbId: result.id, title: result.name, year: result.year, order: admitted.indexOf(result) },
          episodeNames: season.episodes.map((episode) => episode.name)
        };
      })
    );
    const identity = decideByEpisodeTitles({
      checked,
      titles: episodeEvidence.titles,
      uncheckedRemain: admitted.length > toCheck.length
    });
    const checkedIds = new Set(identity.candidates.map(candidate => String(candidate.tmdbId)));
    return { ...identity,
      incomplete: admitted.length > toCheck.length || searches.some(search => search.status !== "complete"),
      diagnostics: {
        candidatesAvailable: admitted.length,
        candidatesChecked: checked.length,
        candidatesTruncated: Math.max(0, admitted.length - toCheck.length),
        checked: checked.slice(0, MAX_EPISODE_CHECKS).map(({ candidate, episodeNames }) => {
          const episodeTitles = new Set(episodeNames.map(normalizeTitle));
          return {
            kind: candidate.kind,
            tmdbId: candidate.tmdbId,
            title: boundedText(candidate.title),
            status: checkedIds.has(String(candidate.tmdbId)) ? "admitted" : "rejected",
            matchedReleaseTitles: episodeEvidence.titles.filter(title => episodeTitles.has(normalizeTitle(title))).slice(0, 12).map(title => boundedText(title))
          };
        })
      }
    };
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
  #search(kind, query, language, wait, pageLimit = MAX_SEARCH_PAGES) {
    return this.#cached(
      `search|${pageLimit}|${kind}|${language}|${query}`,
      (found) => (found.results.length > 0 ? FOUND_TTL_MS : NOTHING_TTL_MS),
      async (fetchDeadline) => {
        const first = await this.#source.search(kind, query, language, 1, { deadlineAt: fetchDeadline });
        const results = [...first.results];
        const lastPage = Math.min(first.totalPages, pageLimit);
        for (let page = 2; page <= lastPage; page += 1) {
          const next = await this.#source.search(kind, query, language, page, { deadlineAt: fetchDeadline });
          results.push(...next.results);
        }
        return { results, capped: first.totalPages > pageLimit, pagesFetched: lastPage, totalPages: first.totalPages };
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
    ).catch(error => {
      providerFailure("tmdb", key.split("|")[0], error);
      throw error;
    });
  }
}
