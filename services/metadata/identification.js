/**
 * @file Which works a set of release names may be — gathered from the
 * provider's search answers. Choosing one of several is `candidate-score.js`.
 *
 * **What counts as a candidate.** A search result whose title, in the
 * requested language or in the work's own, is EQUAL to a searched spelling
 * after {@link normalizeTitle} (`exact`), or begins with it followed by a
 * whole word (`prefix`, as Jellyfin's `TmdbUtils.FindBestMatch` counts it: a
 * search for `Wall` admits `Wall Street` and not `Wallace`); and whose kind
 * agrees with the kind being searched. A year never removes a candidate here;
 * it is scored.
 *
 * **The outcomes.** `identified` — one candidate; `ambiguous` — two or more;
 * `unavailable` — no candidate and some search did not complete; `undetermined`
 * — no candidate and some search had more pages than are read; `not-found` —
 * no candidate and every search complete. A candidate found while another
 * search failed or was capped is still a candidate: identification is a
 * progressive enhancement and chooses from what it has (torrent-tv/meta#172).
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
 * @property {"exact" | "prefix" | "alternative" | "episodes"} titleMatch
 * @property {number} order - Position among the provider's answers; lower came first.
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

/**
 * @param {object} params
 * @param {SearchOutcome[]} params.searches
 * @param {number} [params.candidateLimit]
 * @returns {Identity}
 */
export function decideIdentity({ searches, candidateLimit = 5 }) {
  /** @type {Map<string, Candidate>} */
  const candidates = new Map();
  let order = 0;
  for (const search of searches) {
    for (const result of search.results ?? []) {
      const titles = [normalizeTitle(result.name), normalizeTitle(result.originalName)];
      const match = titles.includes(search.query)
        ? "exact"
        : titles.some((title) => title.startsWith(`${search.query} `)) ? "prefix" : null;
      if (!match) {
        continue;
      }
      const key = `${search.kind}:${result.id}`;
      const known = candidates.get(key);
      if (!known) {
        candidates.set(key, { kind: search.kind, tmdbId: result.id, title: result.name, year: result.year, titleMatch: match, order: order++ });
      } else if (known.titleMatch === "prefix" && match === "exact") {
        known.titleMatch = "exact";
      }
    }
  }
  const found = [...candidates.values()].slice(0, candidateLimit);
  if (found.length >= 2) {
    return { status: "ambiguous", candidates: found };
  }
  if (found.length === 1) {
    return { status: "identified", candidates: found };
  }
  if (searches.some((search) => search.status === "failed")) {
    return { status: "unavailable", candidates: [] };
  }
  if (searches.some((search) => search.status === "capped")) {
    return { status: "undetermined", candidates: [] };
  }
  return { status: "not-found", candidates: [] };
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
export function decideByEpisodeTitles({ checked, titles, uncheckedRemain }) {
  const wanted = [...new Set(titles.map(normalizeTitle).filter((title) => title.length > 0))];
  const qualifiers = [];
  for (const { candidate, episodeNames } of checked) {
    const names = new Set(episodeNames.map(normalizeTitle).filter((name) => name.length > 0));
    const matched = wanted.filter((title) => names.has(title));
    if (matched.length >= 2 && matched.length * 2 >= wanted.length) {
      qualifiers.push({ ...candidate, titleMatch: "episodes" });
    }
  }
  const found = qualifiers;
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
export function decideByAlternativeTitles({ checked, queries, uncheckedRemain }) {
  const wanted = new Set(queries);
  const qualifiers = checked
    .filter(({ titles }) => titles.some((title) => wanted.has(normalizeTitle(title))))
    .map(({ candidate }) => ({ ...candidate, titleMatch: "alternative" }));
  if (qualifiers.length >= 2) {
    return { status: "ambiguous", candidates: qualifiers.slice(0, 5) };
  }
  if (qualifiers.length === 1) {
    return { status: "identified", candidates: qualifiers };
  }
  return { status: uncheckedRemain ? "undetermined" : "not-found", candidates: [] };
}
