/**
 * @file What the media container states about the film, as a metadata source.
 *
 * The container is a source of its own: its title, original title and year
 * enter normalization like those of the databases, ranked per field in
 * `FIELD_PRIORITY`. It is also evidence for the databases: a title in the
 * native language is another name to search, the season and the episode and
 * the title of the episode are stated by the file itself, and an `IMDB`,
 * `TMDB` or `AniList` id replaces a search with a lookup.
 *
 * What the container states is untrusted input from a proxy, so every value is
 * checked and bounded here before it is used. A title that is only a release
 * name is not a title and is never stated; genres are kept in the record and
 * are not a field of the common format.
 */

import { EVIDENCE, MetadataProvider, STAGE } from "./MetadataProvider.js";
import { parseReleaseName } from "./release-name.js";
import { normalizeTitle } from "./title.js";

/** Longest text taken from a container, in characters. A stated limit. */
const MAX_TEXT = 300;

/** Most genres kept from a container. A stated limit. */
const MAX_GENRES = 12;

/**
 * What a container states.
 *
 * @typedef {object} ContainerFacts
 * @property {string} [title]
 * @property {string} [originalTitle] - The title in the language of the work.
 * @property {number} [year]
 * @property {number} [season]
 * @property {number} [episode]
 * @property {string} [episodeTitle]
 * @property {{ imdb?: string, tmdb?: number, anilist?: number }} [externalIds]
 * @property {string[]} [genres]
 */

const text = (value) => (typeof value === "string" && value.trim().length > 0 ? value.trim().slice(0, MAX_TEXT) : undefined);
const integer = (value, min, max) => (Number.isInteger(value) && value >= min && value <= max ? value : undefined);

/**
 * Whether a title is a title and not a release name: reading it as a release
 * name leaves the whole of it.
 *
 * @param {string | undefined} title
 * @returns {boolean}
 */
export function isPlainTitle(title) {
  if (!title) return false;
  const whole = normalizeTitle(title);
  return parseReleaseName(title).titles.some((candidate) => normalizeTitle(candidate) === whole);
}

/**
 * The values of a container that are safe to use.
 *
 * @param {unknown} raw
 * @returns {ContainerFacts | null}
 */
export function readContainerFacts(raw) {
  if (!raw || typeof raw !== "object") return null;
  const ids = raw.externalIds ?? {};
  const externalIds = {};
  if (typeof ids.imdb === "string" && /^tt\d{1,12}$/u.test(ids.imdb)) externalIds.imdb = ids.imdb;
  if (integer(ids.tmdb, 1, 2147483647)) externalIds.tmdb = ids.tmdb;
  if (integer(ids.anilist, 1, 2147483647)) externalIds.anilist = ids.anilist;
  return {
    title: text(raw.title),
    originalTitle: text(raw.originalTitle),
    year: integer(raw.year, 1888, 2100),
    season: integer(raw.season, 0, 999),
    episode: integer(raw.episode, 1, 9999),
    episodeTitle: text(raw.episodeTitle),
    externalIds,
    genres: Array.isArray(raw.genres) ? raw.genres.map(text).filter(Boolean).slice(0, MAX_GENRES) : []
  };
}

export class ContainerMetadata extends MetadataProvider {
  constructor() {
    super({ name: "container", stage: STAGE.evidence, takes: [EVIDENCE.container] });
  }

  evidenceFrom(request) {
    const facts = readContainerFacts(request.container);
    if (!facts) return null;
    return {
      names: [facts.originalTitle, facts.title].filter(isPlainTitle),
      externalIds: facts.externalIds,
      season: facts.season,
      episode: facts.episode,
      episodeTitle: facts.episodeTitle
    };
  }

  contribute(request) {
    return readContainerFacts(request.container);
  }

  fields(record) {
    return {
      kind: record.season !== undefined || record.episode !== undefined ? "series" : undefined,
      title: isPlainTitle(record.title) ? record.title : undefined,
      originalTitle: isPlainTitle(record.originalTitle) ? record.originalTitle : undefined,
      year: record.year
    };
  }
}