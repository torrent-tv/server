/**
 * @file What the page asks the metadata service about a release, and how the
 * answers become what a viewer reads: a numbered episode title in the playlist,
 * a picture while an episode loads.
 *
 * Nothing here requests anything or touches the DOM. The rules it applies are
 * the ones the service states, seen from the page's side:
 *
 *  - which work a release is applies to its pictures only when the proxy says
 *    what the pictures are taken together (`shape`): one work, or a series.
 *    When it is not known — several pictures without episode markers, or a
 *    proxy too old to say — nothing is concluded about the release, and a
 *    picture is identified by its own name only when it is opened;
 *  - the season sent for matching is ALWAYS every file of that season, because
 *    whether a number alone may be trusted is decided over the whole season;
 *  - an answer that is not a match leaves the release's own name on screen.
 */

/** The language every request is made in, until the soundtrack decides it. */
export const METADATA_LANGUAGE = "en-US";

/** Most names sent with one identification; the service accepts 24. */
const MAX_NAMES = 24;

/** Longest name sent; the service accepts 300 characters. */
const MAX_NAME_LENGTH = 300;

/** Image sizes the service serves, by use. */
export const IMAGE_SIZE = { poster: "w342", still: "w780", artwork: "w185" };

/**
 * The address of a TMDB image served through this site.
 *
 * @param {string} size
 * @param {string | null | undefined} file
 * @returns {string | null}
 */
export function imageUrl(size, file) {
  return typeof file === "string" && /^[A-Za-z0-9]{8,64}\.(?:jpg|png)$/.test(file)
    ? `/api/metadata/image/${size}/${file}`
    : null;
}

/**
 * Names cut to what the service accepts, blanks and repeats dropped.
 *
 * @param {Array<unknown>} names
 * @returns {string[]}
 */
export function boundedNames(names) {
  const out = [];
  const seen = new Set();
  for (const name of names) {
    if (typeof name !== "string") {
      continue;
    }
    const text = name.trim().slice(0, MAX_NAME_LENGTH);
    if (text.length === 0 || seen.has(text)) {
      continue;
    }
    seen.add(text);
    out.push(text);
    if (out.length >= MAX_NAMES) {
      break;
    }
  }
  return out;
}

/**
 * What the pictures of a release are taken together. A proxy that states it is
 * believed; one that does not (released before it could) states nothing, and a
 * single picture is the one case that needs no statement.
 *
 * @param {{ shape?: unknown, items?: unknown[] } | null | undefined} contents
 * @returns {"single" | "series" | "undetermined"}
 */
export function shapeOf(contents) {
  if (contents?.shape === "single" || contents?.shape === "series" || contents?.shape === "undetermined") {
    return contents.shape;
  }
  return Array.isArray(contents?.items) && contents.items.length === 1 ? "single" : "undetermined";
}

/**
 * The file name without its folders and extension.
 *
 * @param {string} path
 * @returns {string}
 */
function stemOf(path) {
  const name = String(path ?? "").split("/").pop() ?? "";
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
}

/**
 * The identification of a whole release, once the proxy has said what is in
 * it — or `null` when one identification of the whole release would say
 * nothing true.
 *
 * @param {object} params
 * @param {string[]} params.selectionNames - What was known when the release was chosen.
 * @param {{ name?: string, items?: Array<{ fileIndex: number, episode?: object | null }>, shape?: string }} params.contents
 * @param {Map<number, { relativePath?: string }>} params.filesByIndex
 * @returns {{ names: string[], kindHint: "tv" | "movie" | null } | null}
 */
export function releaseIdentification({ selectionNames, contents, filesByIndex }) {
  const shape = shapeOf(contents);
  if (shape === "undetermined") {
    return null;
  }
  const items = Array.isArray(contents?.items) ? contents.items : [];
  const names = [...selectionNames, contents?.name ?? ""];
  if (shape === "series") {
    for (const item of items) {
      if (item.episode?.showHint) {
        names.push(item.episode.showHint);
      }
    }
    return { names: boundedNames(names), kindHint: "tv" };
  }
  const [only] = items;
  names.push(stemOf(filesByIndex.get(only?.fileIndex)?.relativePath ?? ""));
  return { names: boundedNames(names), kindHint: only?.episode ? "tv" : null };
}

/**
 * The identification of ONE picture of a release whose pictures are not known
 * to be one work: its own name and the folder it sits in, nothing of the rest.
 *
 * @param {{ relativePath?: string } | undefined} file
 * @param {{ episode?: object | null } | undefined} item
 * @returns {{ names: string[], kindHint: "tv" | null }}
 */
export function pictureIdentification(file, item) {
  const parts = String(file?.relativePath ?? "").split("/");
  const folder = parts.length > 1 ? parts[parts.length - 2] : "";
  const seasonFolder = /^(?:season|сезон|s)[ ._-]*\d{1,3}$/iu.test(folder.trim());
  return {
    names: boundedNames([stemOf(file?.relativePath ?? ""), seasonFolder ? "" : folder]),
    kindHint: item?.episode ? "tv" : null
  };
}

/**
 * Which season of a work a picture belongs to, by the proxy's marker.
 *
 * A marker without a season belongs to the work's only season when it has one;
 * specials go to season 0.
 *
 * @param {{ season?: number | null, special?: boolean } | null | undefined} episode
 * @param {{ seasons?: Array<{ number: number }> }} work
 * @returns {number | null}
 */
export function seasonOf(episode, work) {
  if (!episode) {
    return null;
  }
  if (episode.special) {
    return 0;
  }
  if (Number.isInteger(episode.season)) {
    return episode.season;
  }
  const regular = (work?.seasons ?? []).filter((season) => season.number > 0);
  return regular.length === 1 ? regular[0].number : null;
}

/**
 * Every picture of one season, in the shape the service matches.
 *
 * @param {Array<{ fileIndex: number, episode?: object | null }>} items
 * @param {object} work
 * @param {number} season
 * @returns {Array<{ key: string, episodes: number[], part: number | null, special: boolean, titleHint: string }>}
 */
export function seasonFiles(items, work, season) {
  return items
    .filter((item) => seasonOf(item.episode, work) === season)
    .map((item) => ({
      key: String(item.fileIndex),
      episodes: item.episode.episodes,
      part: item.episode.part ?? null,
      special: item.episode.special === true,
      titleHint: String(item.episode.titleHint ?? "").slice(0, 160)
    }));
}

/**
 * What the playlist calls a matched episode: its number in the show, its name,
 * and the part when the release split it.
 *
 * @param {{ episodes: Array<{ number: number, name: string }>, part: number | null }} match
 * @param {{ withSeason?: number | null }} [options] - Name the season too, for a
 *   list that shows several seasons without grouping them.
 * @returns {string}
 */
export function episodeLabel(match, { withSeason = null } = {}) {
  const numbers = match.episodes.map((episode) => episode.number);
  const number = numbers.length > 1 ? `${numbers[0]}–${numbers[numbers.length - 1]}` : String(numbers[0]);
  const names = match.episodes.map((episode) => episode.name).filter((name) => name.length > 0);
  const title = names.length > 0 ? names.join(" / ") : `Episode ${number}`;
  const part = match.part != null ? ` (part ${match.part})` : "";
  const prefix = withSeason != null ? `S${withSeason} E${number}.` : `${number}.`;
  return `${prefix} ${title}${part}`;
}

/**
 * Everything the page knows about the chosen release, as `MEDIA_INFO:CHANGED`
 * carries it.
 *
 * @typedef {object} MediaInfoState
 * @property {number} selection - Which choice of release this is about.
 * @property {object | null} work - The work the whole release is, when it is one.
 * @property {Record<string, string>} seasons - Season number → the provider's name for it.
 * @property {Record<string, { season: number, episodes: Array<{ number: number, name: string, still: string | null }>, part: number | null }>} episodes -
 *   File index → the episode it was matched to. Only matches are here.
 * @property {Record<string, object>} pictures - File index → the work that one
 *   picture is, for a release whose pictures are not known to be one work.
 */

/**
 * The picture to show while a file loads: the episode's own frame, else the
 * work's wide image, else its poster.
 *
 * @param {MediaInfoState | null} state
 * @param {number} fileIndex
 * @returns {string | null}
 */
export function artFor(state, fileIndex) {
  if (!state) {
    return null;
  }
  const match = state.episodes?.[String(fileIndex)];
  const still = match?.episodes.find((episode) => episode.still)?.still;
  const work = state.pictures?.[String(fileIndex)] ?? state.work;
  return (
    imageUrl(IMAGE_SIZE.still, still) ??
    imageUrl(IMAGE_SIZE.still, work?.backdrop) ??
    imageUrl(IMAGE_SIZE.poster, work?.poster)
  );
}

/**
 * The work a file belongs to, when one is known.
 *
 * @param {MediaInfoState | null} state
 * @param {number} fileIndex
 * @returns {object | null}
 */
export function workFor(state, fileIndex) {
  if (!state) {
    return null;
  }
  return state.pictures?.[String(fileIndex)] ?? state.work ?? null;
}

/**
 * A work's title as a line: `Agatha Christie's Poirot (1989)`.
 *
 * @param {{ title?: string, year?: number | null } | null} work
 * @returns {string | null}
 */
export function workLine(work) {
  if (!work?.title) {
    return null;
  }
  return Number.isInteger(work.year) ? `${work.title} (${work.year})` : work.title;
}

/**
 * The playlist's names from what the metadata service matched: a numbered
 * episode title for a matched file, the work's title for a picture identified
 * on its own, and a season's name for a folder whose files are all of one
 * season. Everything else answers `null`, which keeps the release's own name.
 *
 * A list that shows files of several seasons without grouping them names the
 * season in each row, because "1." would otherwise appear once per season.
 *
 * @param {MediaInfoState | null} state
 * @returns {import("./playlist-groups.js").PlaylistNaming}
 */
export function playlistNaming(state) {
  if (!state) {
    return {};
  }
  const matchOf = (file) => state.episodes?.[String(file?.index)] ?? null;
  const seasonsMatched = new Set(Object.values(state.episodes ?? {}).map((match) => match.season));
  const spansSeasons = seasonsMatched.size > 1;
  return {
    fileLabel(file, { grouped }) {
      const match = matchOf(file);
      if (match) {
        return episodeLabel(match, { withSeason: !grouped && spansSeasons ? match.season : null });
      }
      return workLine(state.pictures?.[String(file?.index)] ?? null);
    },
    groupLabel(_folder, files) {
      const seasons = new Set(files.map((file) => matchOf(file)?.season ?? null));
      if (seasons.size !== 1 || seasons.has(null)) {
        return null;
      }
      const [season] = seasons;
      const name = state.seasons?.[String(season)];
      return name && name.length > 0 ? name : season === 0 ? "Specials" : `Season ${season}`;
    }
  };
}
