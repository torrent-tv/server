/**
 * @file Which episode of a season each file of a release is.
 *
 * The release numbers its files; the provider numbers its episodes; the two
 * agree often and not always. Measured on one release (Agatha Christie's
 * Poirot, 71 files): season 2 ships the two parts of one feature-length episode
 * as `e01` and `e02`, which moves every later file one number away from the
 * provider's, and season 12 ships its four episodes in a different order. A
 * number alone would have named the wrong episode for 13 of the 71 files.
 *
 * So a title is evidence and a number is a fallback, and the rules say exactly
 * when each is trusted:
 *
 *  1. a file whose title EQUALS the name of exactly one episode of the season is
 *     that episode, whatever its number says;
 *  2. when that episode's number differs from the file's, the release's
 *     numbering is shown to differ from the provider's for this season, and no
 *     file of the season is matched by number alone;
 *  3. otherwise a file with no usable title is the episode with its number — a
 *     title that matches nothing (a tag, a translation) is no evidence either
 *     way and does not stop this. A file whose number the season does NOT have
 *     is evidence, the same as rule 2: measured on Firefly, where one release
 *     numbers fourteen episodes in production order and the provider lists
 *     eleven in broadcast order, numbers 1-11 would all have named the wrong
 *     episode. So such a number also stops matching by number in the season;
 *     if the provider merely lags behind a running show, the cost is file
 *     names instead of episode names, which is the safe direction;
 *  4. a file that says it is a PART of an episode is matched only by title: its
 *     number is a count of parts, not of episodes, and it also shows the
 *     numbering differs;
 *  5. a file that carries several episodes is matched to all of them only when
 *     every number exists and its title contradicts none of them;
 *  6. a special is matched only by title;
 *  7. a title equal to the names of two episodes, or two files claiming one
 *     episode (other than distinct parts of it), is `ambiguous`.
 *
 * Anything not matched keeps the file's own name on screen. The decision needs
 * EVERY file of the season, because rule 2 is about the season: judged on a
 * subset, the same file could be matched or not depending on what else was
 * sent.
 */

import { normalizeTitle } from "./title.js";

/**
 * One file of a release, as the page sends it.
 *
 * @typedef {object} ReleaseFile
 * @property {string} key - The page's own name for the file.
 * @property {number[]} episodes - The release's numbers.
 * @property {number | null} [part]
 * @property {boolean} [special]
 * @property {string} [titleHint]
 */

/**
 * @typedef {object} FileMatch
 * @property {string} key
 * @property {"matched" | "unmatched" | "ambiguous"} status
 * @property {Array<{ number: number, name: string, still: string | null }>} episodes
 * @property {number | null} part
 */

/**
 * @param {ReleaseFile[]} files
 * @param {import("./TmdbSource.js").Season} season
 * @returns {FileMatch[]}
 */
export function matchSeason(files, season) {
  const byNumber = new Map(season.episodes.map((episode) => [episode.number, episode]));
  /** @type {Map<string, typeof season.episodes>} */
  const byTitle = new Map();
  for (const episode of season.episodes) {
    const title = normalizeTitle(episode.name);
    if (title.length > 0) {
      byTitle.set(title, [...(byTitle.get(title) ?? []), episode]);
    }
  }

  let renumbered = false;
  /** @type {Array<{ file: ReleaseFile, status: "strong" | "provisional" | "unmatched" | "ambiguous", episodes: typeof season.episodes }>} */
  const readings = files.map((file) => {
    const title = normalizeTitle(file.titleHint ?? "");
    const titled = title.length > 0 ? (byTitle.get(title) ?? []) : [];
    if (titled.length > 1) {
      return { file, status: "ambiguous", episodes: [] };
    }
    const titleEpisode = titled[0] ?? null;
    const numbers = Array.isArray(file.episodes) ? file.episodes : [];

    if (file.part != null || file.special) {
      if (file.part != null && titleEpisode && !(numbers.length === 1 && numbers[0] === titleEpisode.number)) {
        renumbered = true;
      }
      return titleEpisode
        ? { file, status: "strong", episodes: [titleEpisode] }
        : { file, status: "unmatched", episodes: [] };
    }

    if (numbers.length > 1) {
      const episodes = numbers.map((number) => byNumber.get(number));
      if ((titleEpisode && !episodes.includes(titleEpisode)) || !episodes.every(Boolean)) {
        renumbered = true;
        return { file, status: "unmatched", episodes: [] };
      }
      return { file, status: "provisional", episodes };
    }

    const numbered = numbers.length === 1 ? (byNumber.get(numbers[0]) ?? null) : null;
    if (titleEpisode) {
      if (titleEpisode !== numbered) {
        renumbered = true;
      }
      return { file, status: "strong", episodes: [titleEpisode] };
    }
    if (!numbered) {
      renumbered = true;
      return { file, status: "unmatched", episodes: [] };
    }
    return { file, status: "provisional", episodes: [numbered] };
  });

  // Rule 2: once the numbering is shown to differ, a number alone names nothing.
  if (renumbered) {
    for (const reading of readings) {
      if (reading.status === "provisional") {
        reading.status = "unmatched";
        reading.episodes = [];
      }
    }
  }

  // Rule 7: one episode claimed twice, except by distinct parts of it.
  const claims = new Map();
  for (const reading of readings) {
    for (const episode of reading.episodes) {
      claims.set(episode.number, [...(claims.get(episode.number) ?? []), reading]);
    }
  }
  for (const claimants of claims.values()) {
    if (claimants.length < 2) {
      continue;
    }
    const parts = claimants.map((reading) => reading.file.part);
    const distinctParts = parts.every((part) => part != null) && new Set(parts).size === parts.length;
    if (!distinctParts) {
      for (const reading of claimants) {
        reading.status = "ambiguous";
        reading.episodes = [];
      }
    }
  }

  return readings.map((reading) => ({
    key: reading.file.key,
    status: reading.status === "strong" || reading.status === "provisional" ? "matched" : reading.status,
    episodes: reading.episodes.map((episode) => ({ number: episode.number, name: episode.name, still: episode.still })),
    part: reading.file.part ?? null
  }));
}
