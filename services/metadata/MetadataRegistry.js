/**
 * @file The list of metadata sources, and the order in which they are asked.
 *
 * The registry does for film metadata what `SubtitleService` does for
 * subtitles: it holds the providers and knows nothing of how any of them asks
 * its database. It owns the order of questions:
 *
 *  1. every source that derives evidence from the request (the container)
 *     adds its names, ids and episode numbers to the request;
 *  2. the primary sources are asked from the request alone, in this order:
 *     1. the exact questions first, whatever the category, because a match is
 *        not a guess: an id of the work in another database (an `IMDB`, `TMDB`
 *        or `TVDB` id the container states), which replaces a search with a
 *        lookup, then the hash of the file;
 *     2. then the names, the kind of database the request states first (adult
 *        when the page states the category adult, general otherwise);
 *     3. the other kind is asked by name only after the supplementary sources
 *        (anime) as well, and only when nothing was found at all — not when
 *        there were several candidates, which is an answer;
 *  3. the supplementary sources are asked with the answer so far in hand;
 *  4. when nothing was found, the primary sources get one last bounded attempt,
 *     and a work found by it is looked at again by the sources interested in it.
 *
 * The answer keeps the record of each source apart, and the common fields are
 * chosen per field by `mergeRecords`.
 */

import { CATEGORY, EVIDENCE, STAGE } from "./MetadataProvider.js";
import { mergeRecords } from "./normalize-work.js";
import { MIN_RUNTIME_SHARE } from "./candidate-score.js";

/** The statuses of an answer that mean no work was found yet. */
const UNRESOLVED = ["not-found", "undetermined", "unavailable"];

/** How good an answer is, to keep the best of several primary sources. */
const RANK = { identified: 4, ambiguous: 3, undetermined: 2, unavailable: 1, "not-found": 0 };

const MAX_ATTEMPTS_REPORTED = 32;
const MAX_SEARCHES_PER_ATTEMPT_REPORTED = 24;
const MAX_RANKED_PER_ATTEMPT_REPORTED = 60;
const MAX_DIAGNOSTIC_NODES_PER_ATTEMPT = 5_000;

function boundedDiagnostic(value, state, depth = 0) {
  state.remaining -= 1;
  if (state.remaining < 0 || depth >= 8) {
    state.truncated = true;
    return null;
  }
  if (typeof value === "string") {
    if (value.length > 200) state.truncated = true;
    return value.slice(0, 200);
  }
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) {
    if (value.length > 60) state.truncated = true;
    return value.slice(0, 60).map(item => boundedDiagnostic(item, state, depth + 1));
  }
  if (typeof value === "object") {
    const entries = Object.entries(value);
    if (entries.length > 40) state.truncated = true;
    return Object.fromEntries(entries.slice(0, 40).map(([key, item]) => [key.slice(0, 100), boundedDiagnostic(item, state, depth + 1)]));
  }
  return null;
}

function attemptSummary(provider, operation, phase, answer) {
  const searches = Array.isArray(answer?.searches) ? answer.searches : [];
  const ranked = Array.isArray(answer?.ranked) ? answer.ranked : [];
  const detailState = { remaining: MAX_DIAGNOSTIC_NODES_PER_ATTEMPT, truncated: false };
  const details = answer?.diagnostics && typeof answer.diagnostics === "object"
    ? boundedDiagnostic(answer.diagnostics, detailState)
    : undefined;
  return {
    provider: provider.name,
    operation,
    phase,
    status: answer?.status ?? "no-answer",
    ...(searches.length ? {
      searches: searches.slice(0, MAX_SEARCHES_PER_ATTEMPT_REPORTED).map(({ kind, query, language, status, totalResults, pagesFetched, totalPages, results, truncated }) => ({
        kind,
        query: typeof query === "string" ? query.slice(0, 200) : null,
        language: typeof language === "string" ? language.slice(0, 32) : null,
        status,
        totalResults: Number.isInteger(totalResults) ? totalResults : Array.isArray(results) ? results.length : 0,
        pagesFetched: Number.isInteger(pagesFetched) ? pagesFetched : null,
        totalPages: Number.isInteger(totalPages) ? totalPages : null,
        returned: Array.isArray(results) ? results.length : 0,
        truncated: Boolean(truncated)
      })),
      searchesTruncated: searches.length > MAX_SEARCHES_PER_ATTEMPT_REPORTED
    } : {}),
    ...(ranked.length ? {
      ranked: ranked.slice(0, MAX_RANKED_PER_ATTEMPT_REPORTED).map(({ kind, tmdbId, title, year, titleMatch, score, contradiction, order }) =>
        ({ kind, tmdbId, title: typeof title === "string" ? title.slice(0, 200) : null, year, titleMatch, score, contradiction, order })),
      rankedTruncated: ranked.length > MAX_RANKED_PER_ATTEMPT_REPORTED
    } : {}),
    ...(details !== undefined ? { details, detailsTruncated: detailState.truncated } : {})
  };
}

export class MetadataRegistry {
  /** @type {import("./MetadataProvider.js").MetadataProvider[]} */
  #providers;

  /** @param {{ providers: import("./MetadataProvider.js").MetadataProvider[] }} params */
  constructor({ providers }) {
    this.#providers = [...providers].sort((a, b) => a.stage - b.stage);
  }

  /** @param {number} stage */
  #at(stage) {
    return this.#providers.filter((provider) => provider.stage === stage);
  }

  /**
   * Which work these names identify.
   *
   * @param {object} request
   * @returns {Promise<{ status: string, work?: object, candidates?: object[] }>}
   */
  async identify(request) {
    const evidenced = this.#withEvidence(request);
    const attempts = [];
    let result = await this.#stages(evidenced, attempts, "initial");
    if (UNRESOLVED.includes(result.status)) {
      let tried = false;
      for (const provider of this.#at(STAGE.primary)) {
        const other = await this.#ask(provider, "lastResort", "last-resort", () => provider.lastResort(evidenced), attempts);
        if (!other) continue;
        tried = true;
        if (["identified", "ambiguous"].includes(other.status) || result.status === "not-found") result = other;
      }
      if (tried && result.status === "identified" && this.#at(STAGE.supplement).some((provider) => provider.interestedIn(evidenced.names, result.work))) {
        const enriched = await this.#stages({ ...evidenced, names: [`${result.work.title} ${result.work.year}`], kindHint: result.work.kind }, attempts, "enrichment");
        if (enriched.status === "identified" && enriched.work?.tmdbId === result.work.tmdbId) result = enriched;
      }
    }
    const { records, ...answer } = result;
    const diagnostics = this.#diagnostics(attempts, answer, result);
    if (answer.status !== "identified") return { ...answer, diagnostics };
    // The candidates the choice was made among, with their scores: public film
    // data, returned so the choice can be read back (and measured).
    return {
      status: "identified",
      work: this.#merge(records ?? {}, evidenced),
      ...(answer.ranked ? { ranked: answer.ranked } : {}),
      ...(answer.searches ? { searches: answer.searches } : {}),
      diagnostics
    };
  }

  /** The episodes of one season, from the first source that answers them. */
  async episodes(request) {
    const provider = this.#providers.find((candidate) => candidate.supportsEpisodes);
    return provider ? provider.episodes(request) : { status: "unavailable" };
  }

  /** The best answer of the primary sources, in the order stated above. */
  async #primary(request, attempts, phase) {
    const sources = this.#at(STAGE.primary);
    const hasNames = Array.isArray(request.names) && request.names.length > 0;
    const first = request.category === "adult" ? CATEGORY.adult : CATEGORY.general;
    let result = null;
    const consider = (answer) => {
      if (!result || RANK[answer.status] > RANK[result.status]) result = answer;
      return result.status === "identified";
    };
    if (request.externalIds && Object.keys(request.externalIds).length > 0) {
      for (const provider of sources.filter((candidate) => candidate.takes.has(EVIDENCE.externalIds))) {
        const answer = await this.#ask(provider, "identifyById", phase, () => provider.identifyById(request), attempts);
        if (answer?.status === "identified" && this.#addressRuntimeContradicts(request, answer.work)) continue;
        if (answer && consider(answer)) return result;
      }
    }
    if (request.fingerprint) {
      for (const provider of sources.filter((candidate) => candidate.takes.has(EVIDENCE.fingerprint))) {
        if (consider(await this.#ask(provider, "identify", phase, () => provider.identify({ ...request, names: [] }), attempts))) return result;
      }
    }
    if (!hasNames) return result ?? { status: "not-found" };
    const byName = { ...request, fingerprint: undefined };
    const named = (kind) => sources.filter((candidate) => candidate.category === kind && candidate.takes.has(EVIDENCE.names) && candidate.accepts(byName));
    for (const provider of named(first)) {
      if (consider(await this.#ask(provider, "identify", phase, () => provider.identify(byName), attempts))) return result;
    }
    return result ?? { status: "not-found" };
  }

  #addressRuntimeContradicts(request, work) {
    const duration = request.durationSeconds;
    if (!Number.isFinite(duration) || duration <= 0 || !work) return false;
    const runtimes = work.kind === "movie" ? [work.runtimeSeconds] : work.episodeRuntimeSeconds ?? [];
    const stated = runtimes.filter(runtime => Number.isFinite(runtime) && runtime > 0);
    return stated.length > 0 && stated.every(runtime => duration < runtime * MIN_RUNTIME_SHARE);
  }

  /**
   * The databases of the other kind, by name. Asked after the supplementary
   * sources (anime), and only when nothing was found at all.
   */
  async #otherKind(request, prior, attempts, phase) {
    if (!["not-found", "undetermined", "unavailable"].includes(prior.status) || !request.names?.length) return prior;
    const byName = { ...request, fingerprint: undefined };
    const other = request.category === "adult" ? CATEGORY.general : CATEGORY.adult;
    let result = prior;
    for (const provider of this.#at(STAGE.primary).filter((candidate) => candidate.category === other && candidate.takes.has(EVIDENCE.names) && candidate.accepts(byName))) {
      const answer = await this.#ask(provider, "identify", phase, () => provider.identify(byName), attempts);
      if (RANK[answer.status] > RANK[result.status]) result = answer;
      if (result.status === "identified") break;
    }
    return result;
  }

  /** The primary sources, then the supplementary ones with the answer so far. */
  async #stages(request, attempts, phase) {
    let result = await this.#primary(request, attempts, phase);
    for (const provider of this.#at(STAGE.supplement)) {
      if (!provider.accepts(request)) continue;
      result = await this.#ask(provider, "identify", phase, () => provider.identify(request, {
        prior: result,
        again: (next) => this.#primary(next, attempts, `${phase}-retry`)
      }), attempts);
    }
    return this.#otherKind(request, result, attempts, phase);
  }

  async #ask(provider, operation, phase, ask, attempts) {
    const answer = await ask();
    attempts.push(answer
      ? attemptSummary(provider, operation, phase, answer)
      : { provider: provider.name, operation, phase, status: "no-answer" });
    return answer;
  }

  #diagnostics(attempts, answer, result) {
    const reported = attempts.slice(0, MAX_ATTEMPTS_REPORTED);
    return {
      version: 1,
      attempts: reported,
      attemptsTruncated: attempts.length > reported.length,
      selection: {
        status: answer.status,
        providers: Object.keys(result.records ?? {}),
        ...(result.work ? {
          kind: result.work.kind ?? null,
          tmdbId: result.work.tmdbId ?? null,
          identification: result.work.identification ?? null
        } : {})
      }
    };
  }

  /** The request with what the sources derive from it added. */
  #withEvidence(request) {
    let next = request;
    for (const provider of this.#providers) {
      if (!provider.accepts(request)) continue;
      const evidence = provider.evidenceFrom(request);
      if (!evidence) continue;
      const added = {};
      if (evidence.names?.length) added.names = [...new Set([...(next.names ?? []), ...evidence.names])];
      if (evidence.externalIds && Object.keys(evidence.externalIds).length > 0) added.externalIds = { ...next.externalIds, ...evidence.externalIds };
      if (evidence.statedYears?.length) added.statedYears = [...new Set([...(next.statedYears ?? []), ...evidence.statedYears])];
      // A season or episode the file states is typed, so it outranks a kind read
      // from names (meta#136: trust per field).
      for (const key of ["season", "episode", "episodeTitle", "kindHint"]) if (evidence[key] !== undefined) added[key] = evidence[key];
      // The release's own files are a whole season of titles, a container one
      // episode's: the page's evidence wins where it states some.
      if (evidence.episodeEvidence !== undefined && !next.episodeEvidence) added.episodeEvidence = evidence.episodeEvidence;
      next = { ...next, ...added };
    }
    return next;
  }

  /** The records of the answer, and those the other sources add, as one work. */
  #merge(records, request) {
    const all = { ...records };
    for (const provider of this.#providers) {
      if (!provider.accepts(request)) continue;
      const contributed = provider.contribute(request);
      if (contributed) all[provider.name] = contributed;
    }
    const entries = [];
    for (const [source, record] of Object.entries(all)) {
      const provider = this.#providers.find((candidate) => candidate.name === source);
      if (provider) entries.push({ source, record, fields: provider.fields(record) });
    }
    return mergeRecords(entries);
  }
}
