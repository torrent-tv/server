/**
 * @file What a release NAME says about the work it carries: the title in one or
 * more spellings, the year, and whether it states itself to be a series.
 *
 * A release name is written for people, not parsers:
 *
 *  - `Poirot.1989-2013.hdrip_[teko]` — a title, a span of years, tags;
 *  - `Пуаро_Агаты_Кристи_Agatha_Christie`s_Poirot_Сезон_1_13_из_13_Серии` — two
 *    titles in two scripts with no separator between them, then a season range;
 *  - `Скитальцы (ТВ-1) Drifters Заблудшие [TV] [12 из 12] [2016, …] [1080p]` —
 *    three titles, the year inside a bracket of genres.
 *
 * So the reading is: take the bracketed groups out (keeping the years and the
 * "this is TV" statements they carry), cut the rest at the first thing that is
 * not a title — a year, a season marker, a release tag — and split what is left
 * into its titles, by an explicit ` / ` or by a change of script.
 *
 * Nothing here decides WHICH work it is. It only offers spellings to search
 * for; whether any of them identifies a work is decided against the provider's
 * answers, and a wrong spelling finds nothing rather than something wrong.
 */

import { normalizeTitle } from "./title.js";
import { guessit } from "guessit-js";
import { parse as parseAnime } from "anitomy";

/**
 * Words that end a title in a release name: resolutions, sources, codecs,
 * audio formats, language and dub tags, and the release groups that sign most
 * of the names in the survey collection. A title word that happens to be one of
 * these ends the title early; the spelling then finds nothing, which is the
 * safe way to be wrong.
 */
const RELEASE_TAGS = new Set([
  "4k", "uhd", "hdr", "hdr10", "dv", "sdr", "imax",
  "web", "webdl", "webrip", "webdlrip", "bdrip", "bluray", "brrip", "bdremux", "remux",
  "hdrip", "dvdrip", "hdtv", "dcprip", "uhdbdrip", "dvd9", "dvd5", "dvd", "bd", "tvrip", "satrip",
  "x264", "x265", "h264", "h265", "hevc", "avc", "xvid", "divx", "10bit", "8bit",
  "aac", "ac3", "dts", "ddp", "ddp5", "dd5", "truehd", "atmos", "flac", "mp3",
  "rus", "eng", "ukr", "jap", "dub", "mvo", "dvo", "avo", "sub", "subs", "multi",
  "lostfilm", "amzn", "nf", "hmax", "dsnp", "extended", "remastered", "repack", "proper",
  "unrated", "ntsc", "pal", "mkv", "mp4", "avi", "torrent"
]);

/** Words that state a season or an episode count and end a title. */
const SERIES_WORDS = /^(?:s\d{1,3}(?:e\d{1,4})?|season|сезон|сезоны|серии|серия|episodes?)$/iu;

/** A year of film or television. */
const YEAR = /^(?:19|20)\d{2}$/;

/** A span of years, `1989-2013`. */
const YEAR_SPAN = /^((?:19|20)\d{2})[-–]((?:19|20)\d{2})$/;

/**
 * What one release name states.
 *
 * @typedef {object} ReleaseName
 * @property {string[]} titles - Spellings of the title, in name order, each
 *   distinct after normalization.
 * @property {{ from: number, to: number } | null} years - The year, or the span
 *   a series ran for; `from` is what a provider's first date is compared with.
 * @property {boolean} seriesEvidence - The name says it is a series: a season
 *   or episode marker, a span of years, or a bracket stating TV.
 */

/**
 * Take bracketed and parenthesised groups out of a name, keeping what they say
 * about years and about being TV.
 *
 * Innermost groups go first, so `[RUS(ext), JAP+Sub]` is removed whole.
 *
 * @param {string} text
 * @returns {{ rest: string, groups: string[] }}
 */
function removeGroups(text) {
  const groups = [];
  let rest = text;
  let previous = "";
  while (rest !== previous) {
    previous = rest;
    rest = rest.replace(/\(([^()]*)\)|\[([^[\]]*)\]|\{([^{}]*)\}/g, (_, round, square, curly) => {
      groups.push(round ?? square ?? curly ?? "");
      return " ";
    });
  }
  return { rest, groups };
}

/**
 * Years a group states, and whether it states TV.
 *
 * @param {string[]} groups
 * @returns {{ years: { from: number, to: number } | null, tv: boolean }}
 */
function readGroups(groups) {
  let years = null;
  let tv = false;
  for (const group of groups) {
    const text = group.trim();
    if (/^(?:tv|тв)(?:[-\s]?\d+)?$/iu.test(text) || /\d+\s*из\s*\d+/u.test(text)) {
      tv = true;
    }
    if (years) {
      continue;
    }
    const span = /(?<!\d)((?:19|20)\d{2})\s*[-–]\s*((?:19|20)\d{2})(?!\d)/.exec(text);
    if (span) {
      years = { from: Number(span[1]), to: Number(span[2]) };
      tv = true;
      continue;
    }
    const year = /(?<!\d)((?:19|20)\d{2})(?!\d)/.exec(text);
    if (year) {
      years = { from: Number(year[1]), to: Number(year[1]) };
    }
  }
  return { years, tv };
}

/**
 * The script a word is written in, for splitting two titles that follow each
 * other with nothing between them.
 *
 * @param {string} word
 * @returns {"cyrillic" | "latin" | "other" | "neutral"}
 */
function scriptOf(word) {
  if (/\p{Script=Cyrillic}/u.test(word)) {
    return "cyrillic";
  }
  if (/\p{Script=Latin}/u.test(word)) {
    return "latin";
  }
  if (/\p{L}/u.test(word)) {
    return "other";
  }
  return "neutral";
}

/**
 * Split a title into runs of one script. A word with no letters — `17` in
 * `Микки 17 Mickey 17` — belongs to the run before it, or to the run after it
 * when it opens the title.
 *
 * @param {string[]} words
 * @returns {string[]}
 */
function splitByScript(words) {
  const runs = [];
  let current = [];
  let script = null;
  let leading = [];
  for (const word of words) {
    const kind = scriptOf(word);
    if (kind === "neutral") {
      if (script === null) {
        leading.push(word);
      } else {
        current.push(word);
      }
      continue;
    }
    if (script !== null && kind !== script) {
      runs.push(current.join(" "));
      current = [];
    }
    if (script === null || kind !== script) {
      current.push(...leading);
      leading = [];
    }
    script = kind;
    current.push(word);
  }
  if (current.length > 0) {
    runs.push(current.join(" "));
  } else if (leading.length > 0) {
    runs.push(leading.join(" "));
  }
  return runs;
}

/**
 * Read one release name.
 *
 * @param {unknown} raw
 * @returns {ReleaseName}
 */
export function parseReleaseName(raw) {
  const release = guessit(String(raw ?? ""), { name_only: true });
  const anime = parseAnime(String(raw ?? ""));
  const text = String(raw ?? "")
    .replace(/\.torrent$/i, "")
    .replace(/\.(?:mkv|mp4|avi|m4v|mov|wmv|ts|m2ts|vob|webm)$/i, "");
  const { rest, groups } = removeGroups(text);
  const fromGroups = readGroups(groups);

  let years = fromGroups.years;
  let seriesEvidence = fromGroups.tv;

  // A double underscore separates two titles in some trackers' names
  // (`Moana__Moana_2016`); every other `.` and `_` is a space.
  const spaced = rest
    .replace(/__+/g, " / ")
    .replace(/[._]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const titleWords = [];
  const words = spaced.split(" ").filter((word) => word.length > 0);
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index];
    const bare = word.replace(/^[-–—,:;]+|[-–—,:;]+$/g, "");
    const lower = bare.toLowerCase();
    const span = YEAR_SPAN.exec(bare);
    if (span) {
      years ??= { from: Number(span[1]), to: Number(span[2]) };
      seriesEvidence = true;
      break;
    }
    // A year opening the name is a title (`2012`), unless nothing else is.
    if (YEAR.test(bare) && titleWords.length > 0) {
      years ??= { from: Number(bare), to: Number(bare) };
      break;
    }
    if (SERIES_WORDS.test(bare)) {
      seriesEvidence = true;
      break;
    }
    if (/^\d{3,4}p$/i.test(bare) || RELEASE_TAGS.has(lower.replace(/[^a-z0-9]/g, ""))) {
      break;
    }
    titleWords.push(word);
  }

  const joined = titleWords.join(" ").replace(/[\s\-–—,:;]+$/g, "");
  const titles = [];
  const seen = new Set();
  for (const piece of joined.split(/\s*[/|]\s*/)) {
    for (const run of splitByScript(piece.split(" ").filter((word) => word.length > 0))) {
      const cleaned = run.replace(/^[\s\-–—,:;]+|[\s\-–—,:;]+$/g, "");
      const key = normalizeTitle(cleaned);
      if (key.length < 2 || seen.has(key)) {
        continue;
      }
      seen.add(key);
      titles.push(cleaned);
    }
  }

  // Title boundaries do not end the collection of technical release evidence.
  // Keep our explicit year spans and multilingual title splitting.
  if (!years && Number.isInteger(release.year) && titles.some(title => title !== String(release.year))) {
    years = { from: release.year, to: release.year };
  }
  if (titles.length === 1 && titles[0] === String(release.year) && (release.source || release.screen_size)) {
    years ??= { from: release.year, to: release.year };
    titles.length = 0;
  }
  const values = {
    year: [release.year, anime.year],
    season: [release.season, anime.season == null ? null : Number(anime.season)],
    episode: [release.episode, anime.episode?.number === release.year ? null : anime.episode?.number],
    resolution: [release.screen_size, anime.video?.resolution],
    videoCodec: [release.video_codec, anime.video?.term],
    audioCodec: [release.audio_codec, anime.audio?.term],
    releaseGroup: [release.release_group, anime.release?.group]
  };
  const normalized = {};
  const conflicts = {};
  for (const [key, supplied] of Object.entries(values)) {
    const distinct = [...new Set(supplied.filter(value => value != null))];
    normalized[key] = distinct.length === 1 ? distinct[0] : null;
    if (distinct.length > 1) conflicts[key] = distinct;
  }
  // Source vocabularies differ: preserve both original labels.
  normalized.source = release.source ?? anime.source ?? null;
  seriesEvidence ||= Number.isInteger(normalized.season);
  if (Number.isInteger(release.episode) && release.title && anime.title &&
      normalizeTitle(release.title) === normalizeTitle(anime.title) && !seen.has(normalizeTitle(release.title))) {
    titles.push(release.title);
  }
  return { titles, years, seriesEvidence, release: { sources: { guessit: release, anitomy: anime }, normalized, conflicts } };
}
