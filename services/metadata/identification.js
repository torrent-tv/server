/**
 * @file Which work a set of release names identifies — decided from the
 * provider's search answers, and only when those answers are complete.
 *
 * **What counts as a candidate.** A search result whose title, in the
 * requested language or in the work's own, is EQUAL to a searched spelling
 * after {@link normalizeTitle}; that has a date; whose year is within one of a
 * year the names state, when they state one; and whose kind agrees with the
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
 * Whether a result's year agrees with the years the names state.
 *
 * A result with no date is never a candidate, whether or not the names state a
 * year: it cannot be checked, and on the provider such entries are placeholders
 * and obscure records. Measured 2026-09-30: `The Continental 1 - LostFilm.TV`
 * matched a dateless `The Continental` rather than the series it is (which the
 * provider titles "The Continental: From the World of John Wick"), and none of
 * its episodes existed there. One year either way covers a work premiering in
 * one country the year before another, which is how the provider's date and a
 * release's year differ.
 *
 * @param {number | null} year
 * @param {number[]} statedYears
 * @returns {boolean}
 */
function yearAgrees(year, statedYears) {
  if (year === null) {
    return false;
  }
  return statedYears.length === 0 || statedYears.some((stated) => Math.abs(stated - year) <= 1);
}

/**
 * @param {object} params
 * @param {SearchOutcome[]} params.searches
 * @param {number[]} params.statedYears - Years the names state; empty when none do.
 * @returns {Identity}
 */
export function decideIdentity({ searches, statedYears }) {
  /** @type {Map<string, Candidate>} */
  const candidates = new Map();
  for (const search of searches) {
    for (const result of search.results ?? []) {
      const titles = [normalizeTitle(result.name), normalizeTitle(result.originalName)];
      if (!titles.includes(search.query) || !yearAgrees(result.year, statedYears)) {
        continue;
      }
      const key = `${search.kind}:${result.id}`;
      if (!candidates.has(key)) {
        candidates.set(key, { kind: search.kind, tmdbId: result.id, title: result.name, year: result.year });
      }
    }
  }
  const found = [...candidates.values()];
  const reported = found.slice(0, 5);
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
 * @param {boolean} params.uncheckedRemain - Results with an agreeing year were left unchecked.
 * @returns {Identity}
 */
export function decideByEpisodeTitles({ checked, titles, uncheckedRemain }) {
  const wanted = [...new Set(titles.map(normalizeTitle).filter((title) => title.length > 0))];
  const qualifiers = [];
  for (const { candidate, episodeNames } of checked) {
    const names = new Set(episodeNames.map(normalizeTitle).filter((name) => name.length > 0));
    const matched = wanted.filter((title) => names.has(title));
    if (matched.length >= 2 && matched.length * 2 >= wanted.length) {
      qualifiers.push(candidate);
    }
  }
  if (qualifiers.length >= 2) {
    return { status: "ambiguous", candidates: qualifiers.slice(0, 5) };
  }
  if (qualifiers.length === 1) {
    return { status: "identified", candidates: qualifiers };
  }
  return { status: uncheckedRemain ? "undetermined" : "not-found", candidates: [] };
}

/**
 * Whether a result's year agrees with years the names DO state; the episode
 * stage checks only results a stated year admits.
 *
 * @param {number | null} year
 * @param {number[]} statedYears
 * @returns {boolean}
 */
export function resultYearAgrees(year, statedYears) {
  return statedYears.length > 0 && yearAgrees(year, statedYears);
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
export function decideByAlternativeTitles({ checked, queries, uncheckedRemain }) {
  const wanted = new Set(queries);
  const qualifiers = checked
    .filter(({ titles }) => titles.some((title) => wanted.has(normalizeTitle(title))))
    .map(({ candidate }) => candidate);
  if (qualifiers.length >= 2) {
    return { status: "ambiguous", candidates: qualifiers.slice(0, 5) };
  }
  if (qualifiers.length === 1) {
    return { status: "identified", candidates: qualifiers };
  }
  return { status: uncheckedRemain ? "undetermined" : "not-found", candidates: [] };
}
