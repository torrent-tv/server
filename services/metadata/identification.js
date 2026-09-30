/**
 * @file Which work a set of release names identifies — decided from the
 * provider's search answers, and only when those answers are complete.
 *
 * **What counts as a candidate.** A search result whose title, in the
 * requested language or in the work's own, is EQUAL to a searched spelling
 * after {@link normalizeTitle}; whose year is within one of a year the names
 * state, when they state one; and whose kind agrees with the kind being
 * searched. The first result of a search is never taken for being first.
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
 * A result with no date cannot be checked, so it does not pass a stated year.
 * One year either way covers a work premiering in one country the year before
 * another, which is how the provider's date and a release's year differ.
 *
 * @param {number | null} year
 * @param {number[]} statedYears
 * @returns {boolean}
 */
function yearAgrees(year, statedYears) {
  if (statedYears.length === 0) {
    return true;
  }
  if (year === null) {
    return false;
  }
  return statedYears.some((stated) => Math.abs(stated - year) <= 1);
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
