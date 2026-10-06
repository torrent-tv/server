/**
 * @file What the media container states about the film, as a metadata source.
 *
 * The proxy reads it from the file the viewer opened (Matroska `Tags`, the MP4
 * iTunes item list, AVI `LIST INFO`; proxy `work-tags.js`) and the page passes
 * it on. The proxy is trusted (user, 2026-10-06); what is checked here is the
 * SHAPE of each value, because the bytes of a file are not.
 *
 * The container is a source of its own: its title, year and description enter
 * normalization like those of the databases, ranked per field in
 * `FIELD_PRIORITY`, after them. It is also evidence for the databases:
 *
 *  1. every title it states is another name to search. A title that is a release
 *     name (`Mortal.Kombat.2021.BDRip-1080p`) is read like one, which is how it
 *     adds a year the file name lacks; a title that is not one is also shown;
 *  2. a stated season or episode says the work is a series, and a stated
 *     episode title is checked against the series' episodes like the titles of
 *     the release's files;
 *  3. an `IMDB`, `TMDB` or `TVDB` id replaces a search with a lookup.
 *
 * Genres are kept in the record and are not a field of the common format: the
 * probe of #136 found LostFilm stating `Drama` for nearly every work.
 */

import { EVIDENCE, MetadataProvider, STAGE } from "./MetadataProvider.js";
import { parseReleaseName } from "./release-name.js";
import { normalizeTitle } from "./title.js";

/** Longest title taken from a container, in characters. A stated limit. */
const MAX_TEXT = 300;

/** Longest description taken from a container, in characters. A stated limit. */
const MAX_DESCRIPTION = 2000;

/** Most genres kept from a container. A stated limit. */
const MAX_GENRES = 12;

/** Most further titles taken from a container. A stated limit. */
const MAX_OTHER_TITLES = 4;

/**
 * What a container states.
 *
 * @typedef {object} ContainerFacts
 * @property {string} [title] - The film, or for an episode the series.
 * @property {string[]} otherTitles
 * @property {string} [seriesTitle]
 * @property {string} [segmentTitle] - A title of the file that says nothing of what it names; often a release name.
 * @property {number} [year] - The year of the work.
 * @property {number} [itemYear] - The year of one episode.
 * @property {number} [season]
 * @property {number} [episode]
 * @property {string} [episodeTitle]
 * @property {string} [description]
 * @property {{ imdb?: string, tmdb?: { kind: "movie" | "tv", id: number }, tvdb?: number }} externalIds
 * @property {string[]} genres
 */

const textOf = (value, limit = MAX_TEXT) => (typeof value === "string" && value.trim().length > 0 ? value.trim().slice(0, limit) : undefined);
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
 * The ids a container states, in the forms the Matroska tagging specification
 * gives them; anything else is dropped.
 *
 * @param {unknown} ids
 * @returns {ContainerFacts["externalIds"]}
 */
function idsOf(ids) {
  const out = {};
  if (!ids || typeof ids !== "object") return out;
  if (typeof ids.imdb === "string" && /^tt\d{7,12}$/u.test(ids.imdb)) out.imdb = ids.imdb;
  const tmdb = ids.tmdb;
  if (tmdb && typeof tmdb === "object" && (tmdb.kind === "movie" || tmdb.kind === "tv") && integer(tmdb.id, 1, 2147483647)) {
    out.tmdb = { kind: tmdb.kind, id: tmdb.id };
  }
  if (integer(ids.tvdb, 1, 2147483647)) out.tvdb = ids.tvdb;
  return out;
}

/**
 * The values of a container that are safe to use.
 *
 * @param {unknown} raw
 * @returns {ContainerFacts | null}
 */
export function readContainerFacts(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const list = (value, max) => (Array.isArray(value) ? value.map((one) => textOf(one)).filter(Boolean).slice(0, max) : []);
  return {
    title: textOf(raw.title),
    otherTitles: list(raw.otherTitles, MAX_OTHER_TITLES),
    seriesTitle: textOf(raw.seriesTitle),
    segmentTitle: textOf(raw.segmentTitle),
    year: integer(raw.year, 1888, 2100),
    itemYear: integer(raw.itemYear, 1888, 2100),
    season: integer(raw.season, 0, 999),
    episode: integer(raw.episode, 0, 9999),
    episodeTitle: textOf(raw.episodeTitle),
    description: textOf(raw.description, MAX_DESCRIPTION),
    externalIds: idsOf(raw.externalIds),
    genres: list(raw.genres, MAX_GENRES)
  };
}

/** Whether the facts say the file is an episode of a series. */
const isEpisode = (facts) => facts.season !== undefined || facts.episode !== undefined || facts.seriesTitle !== undefined;

export class ContainerMetadata extends MetadataProvider {
  constructor() {
    super({ name: "container", stage: STAGE.evidence, takes: [EVIDENCE.container] });
  }

  evidenceFrom(request) {
    const facts = readContainerFacts(request.container);
    if (!facts) return null;
    const episode = isEpisode(facts);
    return {
      names: [...new Set([facts.title, facts.seriesTitle, ...facts.otherTitles, facts.segmentTitle].filter(Boolean))],
      externalIds: facts.externalIds,
      season: facts.season,
      episode: facts.episode,
      episodeTitle: facts.episodeTitle,
      kindHint: episode ? "tv" : undefined,
      episodeEvidence: facts.season !== undefined && facts.episodeTitle ? { season: facts.season, titles: [facts.episodeTitle] } : undefined
    };
  }

  contribute(request) {
    return readContainerFacts(request.container);
  }

  fields(record) {
    const title = [record.title, record.seriesTitle, ...(record.otherTitles ?? [])].find(isPlainTitle);
    return {
      kind: isEpisode(record) ? "series" : undefined,
      title,
      year: record.year,
      overview: record.description
    };
  }
}
