/**
 * @file Which work a set of release names identifies — decided from the
 * provider's search answers, and only when those answers are complete.
 *
 * **What counts as a candidate.** A search result whose title, in the
 * requested language or in the work's own, is EQUAL to a searched spelling
 * after {@link normalizeTitle}; and whose kind agrees with the
 * kind being searched. The first result of a search is never taken for being first.
 *
 * **The outcomes, and why each one is only reached when it is established.**
 *
 *  - `ambiguous` — two or more distinct candidates. Established even if some
 *    searches failed: two works matching is already proof that a name does not
 *    pick one;
 *  - `unavailable` — some search did not complete (the provider refused, the
 *    deadline passed). A single candidate is NOT reported then, because the
 *    search that did not run might have found a second;
 *  - `undetermined` — every search completed, but some had more pages than are
 *    read. Uniqueness among the pages read is not uniqueness of the search;
 *  - `identified` — every search complete, every page read, one candidate;
 *  - `not-found` — every search complete, every page read, no candidate.
 */

import { normalizeTitle } from "./title.js";

/**
 * One search as the decision sees it.
 *
 * @typedef {object} SearchOutcome
 * @property {"tv" | "movie"} kind
 * @property {string} query - Already normalized.
 * @property {"complete" | "capped" | "failed"} status - `capped`: pages exist beyond those read.
 * @property {import("./TmdbSource.js").SearchResult[]} results
 */

/**
 * @typedef {object} Candidate
 * @property {"tv" | "movie"} kind
 * @property {number} tmdbId
 * @property {string} title
 * @property {number | null} year
 */

/**
 * @typedef {object} Identity
 * @property {"identified" | "ambiguous" | "not-found" | "undetermined" | "unavailable"} status
 * @property {Candidate[]} candidates - Every distinct candidate found, at most five reported.
 */

/**
 * Prefer agreeing years among candidates already qualified by title or episode
 * evidence. Missing or differing years never prevent a candidate being checked,
 * and never discard every qualifying candidate.
 *
 * @param {Array<{ year: number | null }>} candidates
 * @param {number[]} statedYears
 * @returns {Array<{ year: number | null }>}
 */
export function preferYearMatches(candidates, statedYears = []) {
  const preferred = candidates.filter(candidate => Number.isInteger(candidate.year) &&
    statedYears.some(stated => Math.abs(stated - candidate.year) <= 1));
  return preferred.length ? preferred : candidates;
}

export function latestCandidate(candidates) {
  return [...candidates].sort((left, right) => (right.year ?? 0) - (left.year ?? 0) || left.tmdbId - right.tmdbId || left.kind.localeCompare(right.kind))[0];
}

/**
 * @param {object} params
 * @param {SearchOutcome[]} params.searches
 * @param {number[]} params.statedYears - Years the names state; empty when none do.
 * @returns {Identity}
 */
export function decideIdentity({ searches, statedYears, runtimeMatches = null, candidateLimit = 5, preferLatest = false }) {
  /** @type {Map<string, Candidate>} */
  const candidates = new Map();
  for (const search of searches) {
    for (const result of search.results ?? []) {
      const titles = [normalizeTitle(result.name), normalizeTitle(result.originalName)];
      if (!titles.includes(search.query)) {
        continue;
      }
      const key = `${search.kind}:${result.id}`;
      if (!candidates.has(key)) {
        candidates.set(key, { kind: search.kind, tmdbId: result.id, title: result.name, year: result.year });
      }
    }
  }
  const all = [...candidates.values()];
  const durationPreferred = runtimeMatches ? all.filter(candidate => runtimeMatches.has(`${candidate.kind}:${candidate.tmdbId}`)) : [];
  const found = preferYearMatches(durationPreferred.length ? durationPreferred : all, statedYears);
  const reported = found.slice(0, candidateLimit);
  if (found.length >= 2 && preferLatest && searches.every(search => search.status === "complete")) {
    return { status: "identified", candidates: [latestCandidate(found)], selectionReason: "latest-year" };
  }
  if (found.length >= 2) {
    return { status: "ambiguous", candidates: reported };
  }
  if (searches.some((search) => search.status === "failed")) {
    return { status: "unavailable", candidates: [] };
  }
  if (searches.some((search) => search.status === "capped")) {
    return { status: "undetermined", candidates: reported };
  }
  return found.length === 1
    ? { status: "identified", candidates: reported }
    : { status: "not-found", candidates: [] };
}

/**
 * A series identified by its EPISODES when no title matched.
 *
 * A release name often shortens the title - `Poirot.1989-2013` for a series the
 * provider calls "Agatha Christie's Poirot" - and title equality then finds
 * nothing. The episode names in the files are stronger evidence than any title:
 * a show whose season carries the same episode names is that show. Equality is
 * still exact after {@link normalizeTitle}; a candidate qualifies when the
 * files' titles name at least two different episodes of its season, and at
 * least half of the titles sent name one of them. One qualifier is the work;
 * two are `ambiguous`; none, with results left unchecked, is `undetermined`.
 *
 * @param {object} params
 * @param {Array<{ candidate: Candidate, episodeNames: string[] }>} params.checked -
 *   Every candidate checked, with the episode names of the evidence season.
 * @param {string[]} params.titles - The files' titles for that season.
 * @param {boolean} params.uncheckedRemain - Search results were left unchecked.
 * @returns {Identity}
 */
export function decideByEpisodeTitles({ checked, titles, uncheckedRemain, statedYears = [] }) {
  const wanted = [...new Set(titles.map(normalizeTitle).filter((title) => title.length > 0))];
  const qualifiers = [];
  for (const { candidate, episodeNames } of checked) {
    const names = new Set(episodeNames.map(normalizeTitle).filter((name) => name.length > 0));
    const matched = wanted.filter((title) => names.has(title));
    if (matched.length >= 2 && matched.length * 2 >= wanted.length) {
      qualifiers.push(candidate);
    }
  }
  const found = preferYearMatches(qualifiers, statedYears);
  if (found.length >= 2) {
    return { status: "ambiguous", candidates: found.slice(0, 5) };
  }
  if (found.length === 1) {
    return { status: "identified", candidates: found };
  }
  return { status: uncheckedRemain ? "undetermined" : "not-found", candidates: [] };
}

/**
 * A work identified by one of its ALTERNATIVE titles when no main or original
 * title matched.
 *
 * The provider keeps the spellings a work was released or transliterated
 * under beside its main title: "Hard to Be a God" lists `Trudno byt' bogom`,
 * "Howl's Moving Castle" lists `Hauru no Ugoku Shiro`. A release named in one
 * of those spellings matches nothing by title and is found by this stage. The
 * comparison is the same exact equality after {@link normalizeTitle}. One work
 * whose alternative titles contain a searched spelling is the work; two are
 * `ambiguous`; none, with results left unchecked, is `undetermined`.
 *
 * @param {object} params
 * @param {Array<{ candidate: Candidate, titles: string[] }>} params.checked
 * @param {string[]} params.queries - Every spelling searched, normalized.
 * @param {boolean} params.uncheckedRemain
 * @returns {Identity}
 */
export function decideByAlternativeTitles({ checked, queries, uncheckedRemain, statedYears = [] }) {
  const wanted = new Set(queries);
  const qualifiers = preferYearMatches(checked
    .filter(({ titles }) => titles.some((title) => wanted.has(normalizeTitle(title))))
    .map(({ candidate }) => candidate), statedYears);
  if (qualifiers.length >= 2) {
    return { status: "ambiguous", candidates: qualifiers.slice(0, 5) };
  }
  if (qualifiers.length === 1) {
    return { status: "identified", candidates: qualifiers };
  }
  return { status: uncheckedRemain ? "undetermined" : "not-found", candidates: [] };
}
