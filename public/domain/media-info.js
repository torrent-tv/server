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
  // A cover of an adult scene is already the address of this server's own route.
  const cover = typeof file === "string" ? file.split("/") : [];
  if (cover.length === 6 && cover[1] === "api" && cover[2] === "metadata" && cover[3] === "cover" && ["theporndb", "stashdb"].includes(cover[4]) && /^[0-9a-f-]{36}$/.test(cover[5])) {
    return file;
  }
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
    return { names: boundedNames(names), kindHint: "tv", episodeEvidence: episodeEvidenceOf(items) };
  }
  const [only] = items;
  names.push(stemOf(filesByIndex.get(only?.fileIndex)?.relativePath ?? ""));
  return { names: boundedNames(names), kindHint: only?.episode ? "tv" : null };
}

/**
 * The episode titles one season of a release carries, for the service to tell
 * the series by its episodes when no title matches (`Poirot.1989-2013` for a
 * show called "Agatha Christie's Poirot"). The season chosen is the one with
 * the most titled files; parts and specials are left out, since their titles
 * name an episode differently or not at all.
 *
 * @param {Array<{ episode?: object | null }>} items
 * @returns {{ season: number, titles: string[] } | null}
 */
export function episodeEvidenceOf(items) {
  const bySeason = new Map();
  for (const item of items) {
    const episode = item.episode;
    if (!episode || episode.special || episode.part != null || !Number.isInteger(episode.season)) {
      continue;
    }
    const title = String(episode.titleHint ?? "").trim();
    if (title.length === 0) {
      continue;
    }
    bySeason.set(episode.season, [...(bySeason.get(episode.season) ?? []), title.slice(0, 160)]);
  }
  let best = null;
  for (const [season, titles] of [...bySeason].sort((left, right) => left[0] - right[0])) {
    if (!best || titles.length > best.titles.length) {
      best = { season, titles };
    }
  }
  return best ? { season: best.season, titles: best.titles.slice(0, 50) } : null;
}

/**
 * The identification of ONE picture of a release whose pictures are not known
 * to be one work: its own name and the folder it sits in, nothing of the rest.
 * Missing years never prevent identification; ambiguous titles remain unresolved
 * until the service has additional evidence.
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
 * Whether a series the service identified has every season the release's
 * files name. A work without them is not this release: measured on
 * `The Continental 1 - LostFilm.TV`, whose files are season 1 of a series the
 * provider found under another record with no episodes of it.
 *
 * @param {Array<{ episode?: { season?: number | null, special?: boolean } | null }>} items
 * @param {{ seasons?: Array<{ number: number }> }} work
 * @returns {boolean}
 */
export function seasonsAgree(items, work) {
  const known = new Set((work?.seasons ?? []).map((season) => season.number));
  const regular = [...known].filter((number) => number > 0);
  for (const item of items) {
    const episode = item.episode;
    if (!episode) {
      continue;
    }
    if (episode.special) {
      if (!known.has(0)) {
        return false;
      }
    } else if (Number.isInteger(episode.season)) {
      if (!known.has(episode.season)) {
        return false;
      }
    } else if (regular.length === 0) {
      return false;
    }
  }
  return true;
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
export function episodeLabel(match, { withSeason = null, releaseNumbers = null } = {}) {
  const numbers = releaseNumbers?.length ? releaseNumbers : match.episodes.map((episode) => episode.number);
  const number = numbers.length > 1 ? `${numbers[0]}–${numbers[numbers.length - 1]}` : String(numbers[0]);
  const names = match.episodes.map((episode) => episode.name).filter((name) => name?.length > 0 && !/^Episode\s+\d+$/i.test(name));
  const title = names.length > 0 ? names.join(" / ") : `Episode ${number}`;
  const part = match.part != null ? ` (part ${match.part})` : "";
  if (names.length === 0) return `${withSeason != null ? `Season ${withSeason} | ` : ""}${title}${part}`;
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
 * @property {Record<string, object>} [containers] - File index → what that file
 *   states about its work, read by the proxy, with `coverUrl` and `coverType`
 *   when it carries a cover.
 */

/** The fields of what a file states that identification reads (server `ContainerMetadata.js`). */
const CONTAINER_FIELDS = ["title", "otherTitles", "seriesTitle", "segmentTitle", "year", "itemYear", "season", "episode",
  "episodeTitle", "description", "externalIds", "genres"];

/**
 * What a file states about its work, cut to what identification reads — the
 * track and chapter titles and the cover stay on the page.
 *
 * @param {object | null | undefined} container
 * @returns {object | null}
 */
export function containerEvidence(container) {
  if (!container || typeof container !== "object") return null;
  const out = {};
  for (const field of CONTAINER_FIELDS) if (container[field] !== undefined && container[field] !== null) out[field] = container[field];
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * What one file states about its work, as the page keeps it, with the address
 * of its cover when it carries one.
 *
 * @param {MediaInfoState | null} state
 * @param {number} fileIndex
 * @returns {object | null}
 */
export function containerFor(state, fileIndex) {
  return state?.containers?.[String(fileIndex)] ?? null;
}

/**
 * The episode a file states about itself, in the shape of a provider's match,
 * or `null` when it does not state both its number and its title. The number
 * the file states comes first; the one its name carries is used when the file
 * states only a title.
 *
 * @param {object | null} container
 * @param {{ season?: number | null, episodes?: number[] } | null | undefined} marker
 * @returns {{ source: "container", season: number | null, episodes: Array<{ number: number, name: string, still: null }>, part: null } | null}
 */
export function containerEpisode(container, marker) {
  const number = Number.isInteger(container?.episode) ? container.episode : marker?.episodes?.[0];
  if (typeof container?.episodeTitle !== "string" || container.episodeTitle.length === 0 || !Number.isInteger(number)) return null;
  const season = Number.isInteger(container.season) ? container.season : Number.isInteger(marker?.season) ? marker.season : null;
  return { source: "container", season, episodes: [{ number, name: container.episodeTitle, still: null }], part: null };
}

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
    imageUrl(IMAGE_SIZE.still, (work?.normalized ?? work)?.backdrop) ??
    imageUrl(IMAGE_SIZE.poster, (work?.normalized ?? work)?.poster) ??
    containerFor(state, fileIndex)?.coverUrl ??
    null
  );
}

/**
 * The work a file belongs to, when one is known. A year or a description the
 * work lacks is filled from what the file states; nothing the work states is
 * replaced (meta#139).
 *
 * @param {MediaInfoState | null} state
 * @param {number} fileIndex
 * @returns {object | null}
 */
export function workFor(state, fileIndex) {
  if (!state) {
    return null;
  }
  const raw = state.pictures?.[String(fileIndex)] ?? state.work ?? null;
  const work = raw?.normalized ?? raw;
  const container = containerFor(state, fileIndex);
  if (!work || !container) return work;
  const filled = {};
  if (!Number.isInteger(work.year) && Number.isInteger(container.year)) filled.year = container.year;
  if (!work.overview && typeof container.description === "string" && container.description.length > 0) filled.overview = container.description;
  return Object.keys(filled).length > 0 ? { ...work, ...filled } : work;
}

/**
 * A work's title as a line: `Agatha Christie's Poirot (1989)`.
 *
 * @param {{ title?: string, year?: number | null } | null} work
 * @returns {string | null}
 */
export function workLine(work) {
  work = work?.normalized ?? work;
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
  const markerOf = file => state.markers?.[String(file?.index)];
  const matchOf = (file) => state.episodes?.[String(file?.index)] ?? null;
  const seasonsMatched = new Set(Object.values(state.episodes ?? {}).map((match) => match.season));
  const spansSeasons = seasonsMatched.size > 1;
  return {
    groupKey(file) {
      const marker = markerOf(file);
      if (!marker) return null;
      const season = marker?.season ?? matchOf(file)?.season ?? seasonOf(marker, state.work?.normalized ?? state.work);
      return Number.isInteger(season) ? "season:" + season : null;
    },
    fileLabel(file, { grouped }) {
      const match = matchOf(file);
      if (match) {
        return episodeLabel(match, { withSeason: !grouped && spansSeasons ? match.season : null, releaseNumbers: markerOf(file)?.episodes });
      }
      return markerLabel(state.markers?.[String(file?.index)], !grouped && spansSeasons) ?? workLine(state.pictures?.[String(file?.index)] ?? null);
    },
    groupLabel(folder, files) {
      if (folder.startsWith("season:")) { const number = Number(folder.slice(7)); return state.seasons?.[number] || (number === 0 ? "Specials" : "Season " + number); }
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

/** A release number remains useful even when provider matching fails. */
export function markerLabel(marker, withSeason = false) {
  if (!marker?.episodes?.length) return null;
  const number = marker.episodes.join("–");
  const season = withSeason && Number.isInteger(marker.season) ? "Season " + marker.season + " | " : "";
  return season + "Episode " + number + (marker.part != null ? " (part " + marker.part + ")" : "");
}

export function pageTitle(state, index) {
  if (!state) return "Torrent TV";
  const work = workFor(state, index);
  const title = work?.title || state.releaseName;
  if (!title) return "Torrent TV";
  const parts = ["Torrent TV", title];
  const marker = state.markers?.[String(index)];
  const match = state.episodes?.[String(index)];
  const season = marker?.season ?? match?.season;
  if (Number.isInteger(season)) parts.push(season === 0 ? "Specials" : "Season " + season);
  const number = marker?.episodes?.join("–") || match?.episodes?.map(e => e.number).join("–");
  if (number) {
    const names = match?.episodes?.map(e => e.name).filter(name => name && !/^Episode\s+\d+$/i.test(name)).join(" / ");
    parts.push("Episode " + number + (names ? ": " + names : ""));
  }
  return parts.join(" | ");
}

/** Widths of the poster renditions the operating system's media controls choose from. */
const SYSTEM_ARTWORK_WIDTHS = [185, 342, 500, 780];

/**
 * The poster for the operating system's media controls (lock screen, media
 * window). Every poster at least as wide as the smallest rendition is equally
 * suitable, so one of them is taken at random; the work's main poster is the
 * answer when the provider listed none.
 *
 * The chosen poster is offered in every listed width it is large enough for:
 * the slot's size and pixel density are the system's, not the page's, so the
 * system picks the rendition by the `sizes` it is given.
 *
 * @param {MediaInfoState | null} state
 * @param {number} index
 * @param {() => number} [random] - A number in [0, 1), as `Math.random` gives.
 * @returns {Array<{ src: string, sizes: string }>}
 */
export function systemArtwork(state, index, random = Math.random) {
  const work = workFor(state, index);
  const smallest = SYSTEM_ARTWORK_WIDTHS[0];
  const suitable = (work?.images ?? []).filter(i => (i.role ?? i.kind) === "poster" && i.width >= smallest);
  const image = suitable[Math.floor(random() * suitable.length)];
  if (!image) {
    // The main poster's size is not listed; 278 is the 2:3 height declared for it before.
    const src = imageUrl(IMAGE_SIZE.artwork, work?.poster);
    if (src) return [{ src, sizes: smallest + "x278" }];
    // The cover the file carries: its size is the image's own, so none is declared.
    const cover = containerFor(state, index);
    return cover?.coverUrl ? [{ src: cover.coverUrl, sizes: "", type: cover.coverType }] : [];
  }
  return SYSTEM_ARTWORK_WIDTHS.filter(width => width <= image.width).map(width => ({
    src: imageUrl("w" + width, image.file),
    sizes: width + "x" + Math.round(width * image.height / image.width)
  })).filter(rendition => rendition.src);
}

/**
 * Select an orientation and the smallest sufficient TMDB rendition.
 *
 * Images of the preferred orientation that are large enough for the player are
 * equally suitable: language and rating do not distinguish them, so one of
 * them is taken at random. Each call is a new choice; the caller asks once per
 * load of a file.
 *
 * @param {() => number} [random] - A number in [0, 1), as `Math.random` gives.
 */
export function playerArt(state, index, width, height, dpr = 1, random = Math.random) {
  const work = workFor(state, index);
  const images = work?.images ?? [];
  const portrait = height > width;
  const preferred = images.filter(i => (i.role ?? i.kind) === (portrait ? "poster" : "backdrop"));
  const alternate = images.filter(i => (i.role ?? i.kind) === (portrait ? "backdrop" : "poster"));
  const still = state?.episodes?.[String(index)]?.episodes.find(e => e.still)?.still;
  const candidates = [...preferred, ...(still ? [{file: still, kind: "still"}] : []), ...alternate];
  if (!candidates.length) {
    const file = portrait ? work?.poster || work?.backdrop || still : work?.backdrop || still || work?.poster;
    if (file) candidates.push({file, kind: file === work?.poster ? "poster" : "backdrop"});
  }
  const sufficient = i => i.width >= width * dpr && i.height >= height * dpr;
  const suitable = preferred.filter(sufficient);
  const image = suitable[Math.floor(random() * suitable.length)] ?? preferred.reduce((best, i) => !best || i.width * i.height > best.width * best.height ? i : best, null) ?? candidates[0];
  if (!image) {
    // The cover the file carries, shown at its own size.
    const cover = containerFor(state, index)?.coverUrl;
    return cover ? { url: cover, width: null, height: null } : null;
  }
  const need = image.width && image.height ? Math.max(width * dpr, height * dpr * image.width / image.height) : Infinity;
  const role = image.role ?? image.kind;
  const sizes = role === "poster" ? [342, 500, 780] : role === "still" ? [300] : [300, 780, 1280];
  const size = sizes.find(n => n >= need && (!image.width || n <= image.width));
  return {url: imageUrl(size ? "w" + size : "original", image.file), width: image.width, height: image.height};
}
