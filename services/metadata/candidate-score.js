/**
 * @file Which of several candidate works a release most likely is.
 *
 * Identification is a progressive enhancement: it never blocks playback and it
 * always chooses (decided with the user, torrent-tv/meta#172). The choice is
 * made in two steps.
 *
 * 1. **A candidate that contradicts a fact of the release is set aside**: a
 *    film offered for a release of numbered episodes, a work that started after
 *    the torrent was created, an episode number beyond the season's count. If
 *    every candidate contradicts something, no work is identified.
 * 2. **The rest are ranked by a score**: each feature gives a share from 0 to 1,
 *    an unknown feature gives 0 and takes nothing away, and the shares are
 *    weighted and added. A sum, not an order of features: an order lets a small
 *    advantage in the title outweigh a matching runtime and a matching episode
 *    count together. Equal scores keep the order the provider returned the
 *    candidates in, as Jellyfin's `TmdbUtils.FindBestMatch` does.
 *
 * Pure: the records are fetched by the caller.
 */

import { normalizeTitle } from "./title.js";

/**
 * Year and runtime dominate the score when the release states them. A year
 * mismatch beyond one year, or a runtime below 70% of the measured duration,
 * is also a contradiction and cannot identify a candidate. A 300-release
 * IMDb-labelled survey retained these weights after a train/holdout fit;
 * feature coverage and the measured result are recorded in torrent-tv/meta#172.
 */
const WEIGHTS = Object.freeze({ title: 8, year: 32, runtime: 24, episodes: 2, russianTitle: 1, releaseCount: 1, episodeTitles: 1, language: 1 });

const MIN_RUNTIME_SHARE = 0.7;

/** The share a title match gives, by how the candidate was found. */
const TITLE_SHARE = Object.freeze({ exact: 1, prefix: 0.5, alternative: 0.5, episodes: 0 });

/**
 * ISO 639-2 codes, as containers write a track's language, to the ISO 639-1
 * codes TMDB states a work's original language in. Both bibliographic and
 * terminological forms where they differ.
 */
const LANGUAGE_639_1 = Object.freeze({
  eng: "en", jpn: "ja", rus: "ru", ukr: "uk", kor: "ko", chi: "zh", zho: "zh", fre: "fr", fra: "fr",
  ger: "de", deu: "de", spa: "es", ita: "it", por: "pt", hin: "hi", tha: "th", tur: "tr", pol: "pl",
  swe: "sv", dan: "da", nor: "no", fin: "fi", dut: "nl", nld: "nl", cze: "cs", ces: "cs", hun: "hu",
  ara: "ar", heb: "he", per: "fa", fas: "fa", gre: "el", ell: "el", ind: "id", vie: "vi", tam: "ta", tel: "te"
});

/**
 * @typedef {object} ScoredCandidate
 * @property {"tv" | "movie"} kind
 * @property {number} tmdbId
 * @property {string} title
 * @property {number | null} year
 * @property {"exact" | "prefix" | "alternative" | "episodes"} titleMatch
 * @property {number} order - Position among the provider's answers; lower came first.
 */

/**
 * @typedef {object} ReleaseEvidence
 * @property {number[]} [statedYears] - Years the names state.
 * @property {number | null} [createdYear] - The year the torrent was created.
 * @property {boolean} [series] - The release is numbered episodes.
 * @property {Map<number | null, number>} [highestEpisode] - Season → its highest episode number in the
 *   release; `null` for numbers that name no season (`Drifters - 01`), counted across every season.
 * @property {number | null} [durationSeconds] - One picture's measured duration.
 * @property {string[]} [audioLanguages] - ISO 639-2 or 639-1 codes of the audio tracks.
 * @property {number} [releaseEpisodeCount] - Distinct numbered episodes in the release.
 * @property {string[]} [episodeTitles] - Titles stated by episode files.
 * @property {string[]} [russianTitles] - Russian title spellings stated by release names.
 */

/**
 * @param {string} code
 * @returns {string}
 */
function language639_1(code) {
  const lower = String(code ?? "").trim().toLowerCase();
  return LANGUAGE_639_1[lower] ?? lower;
}

/**
 * How many episodes a record states for one season, or for the whole series
 * when `season` is `null` (specials, season 0, left out). `null` when the
 * record states none.
 *
 * @param {{ seasons?: Array<{ number: number, episodeCount: number }> } | null} record
 * @param {number | null} season
 * @returns {number | null}
 */
function episodeCountOf(record, season) {
  const seasons = record?.seasons ?? [];
  if (season === null) {
    const total = seasons.filter((one) => one.number > 0).reduce((sum, one) => sum + (one.episodeCount > 0 ? one.episodeCount : 0), 0);
    return total > 0 ? total : null;
  }
  const stated = seasons.find((one) => one.number === season);
  return stated && stated.episodeCount > 0 ? stated.episodeCount : null;
}

/**
 * What a candidate contradicts, or `null`.
 *
 * @param {ScoredCandidate} candidate
 * @param {{ seasons?: Array<{ number: number, episodeCount: number }> } | null} record
 * @param {ReleaseEvidence} evidence
 * @returns {string | null}
 */
function contradiction(candidate, record, evidence) {
  if (evidence.series && candidate.kind === "movie") return "film-for-episodes";
  if (Number.isInteger(candidate.year) && evidence.statedYears?.length > 0 &&
      Math.min(...evidence.statedYears.map(year => Math.abs(year - candidate.year))) > 1) return "year-mismatch";
  if (Number.isInteger(evidence.createdYear) && Number.isInteger(candidate.year) && candidate.year > evidence.createdYear) {
    return "after-torrent";
  }
  const duration = evidence.durationSeconds;
  const runtimes = record ? (candidate.kind === "movie" ? [record.runtimeSeconds] : record.episodeRuntimeSeconds ?? []) : [];
  if (Number.isFinite(duration) && duration > 0 && runtimes.some(runtime => Number.isFinite(runtime) && runtime > 0) &&
      Math.max(...runtimes.filter(runtime => Number.isFinite(runtime) && runtime > 0)
        .map(runtime => Math.min(duration / runtime, runtime / duration))) < MIN_RUNTIME_SHARE) return "runtime-mismatch";
  for (const [season, highest] of evidence.highestEpisode ?? []) {
    const count = episodeCountOf(record, season);
    if (count !== null && highest > count) return "episode-beyond-season";
  }
  return null;
}

/**
 * Each feature's share for one candidate, from 0 to 1.
 *
 * @param {ScoredCandidate} candidate
 * @param {{ kind?: string, runtimeSeconds?: number | null, episodeRuntimeSeconds?: number[], seasons?: Array<{ number: number, episodeCount: number }>, originalLanguage?: string | null, russianTitle?: string, episodeTitles?: string[], totalEpisodeCount?: number | null } | null} record
 * @param {ReleaseEvidence} evidence
 * @returns {{ title: number, year: number, runtime: number, episodes: number, russianTitle: number, releaseCount: number, episodeTitles: number, language: number }}
 */
function shares(candidate, record, evidence) {
  const years = evidence.statedYears ?? [];
  const yearGap = Number.isInteger(candidate.year) && years.length > 0
    ? Math.min(...years.map((year) => Math.abs(year - candidate.year)))
    : null;
  const runtimes = record ? (candidate.kind === "movie" ? [record.runtimeSeconds] : record.episodeRuntimeSeconds ?? []) : [];
  const duration = evidence.durationSeconds;
  const closeness = Number.isFinite(duration) && duration > 0
    ? Math.max(0, ...runtimes.filter((runtime) => Number.isFinite(runtime) && runtime > 0)
      .map((runtime) => Math.min(duration / runtime, runtime / duration)))
    : 0;
  const seasons = [...(evidence.highestEpisode ?? [])];
  const fits = seasons.length > 0 && seasons.every(([season, highest]) => {
    const count = episodeCountOf(record, season);
    return count !== null && count >= highest;
  });
  const original = record?.originalLanguage ? language639_1(record.originalLanguage) : "";
  const spoken = (evidence.audioLanguages ?? []).map(language639_1);
  const normalizedRussian = (evidence.russianTitles ?? []).map(normalizeTitle);
  const russianTitle = normalizeTitle(record?.russianTitle ?? "");
  const releaseCount = Number.isFinite(evidence.releaseEpisodeCount) && Number.isFinite(record?.totalEpisodeCount) && evidence.releaseEpisodeCount > 0 && record.totalEpisodeCount > 0
    ? Math.min(evidence.releaseEpisodeCount / record.totalEpisodeCount, record.totalEpisodeCount / evidence.releaseEpisodeCount)
    : 0;
  const episodeNames = (record?.episodeTitles ?? []).map(normalizeTitle);
  const wantedEpisodeNames = (evidence.episodeTitles ?? []).map(normalizeTitle);
  const episodeTitles = wantedEpisodeNames.length > 0
    ? wantedEpisodeNames.filter((title) => episodeNames.includes(title)).length / wantedEpisodeNames.length
    : 0;
  return {
    title: TITLE_SHARE[candidate.titleMatch] ?? 0,
    year: yearGap === 0 ? 1 : yearGap === 1 ? 0.5 : 0,
    runtime: closeness,
    episodes: fits ? 1 : 0,
    russianTitle: russianTitle && normalizedRussian.includes(russianTitle) ? 1 : 0,
    releaseCount,
    episodeTitles,
    language: original && spoken.includes(original) ? 1 : 0
  };
}

/**
 * Every candidate with its shares, score and contradiction, best first.
 *
 * @param {ScoredCandidate[]} candidates
 * @param {Map<string, object>} records - `kind:tmdbId` → the work's record, where read.
 * @param {ReleaseEvidence} evidence
 * @returns {Array<ScoredCandidate & { shares: ReturnType<typeof shares>, score: number, contradiction: string | null }>}
 */
export function rankCandidates(candidates, records, evidence) {
  const scored = candidates.map((candidate) => {
    const record = records.get(`${candidate.kind}:${candidate.tmdbId}`) ?? null;
    const parts = shares(candidate, record, evidence);
    const score = Object.entries(WEIGHTS).reduce((sum, [feature, weight]) => sum + weight * parts[feature], 0);
    return { ...candidate, shares: parts, score, contradiction: contradiction(candidate, record, evidence) };
  });
  const byScore = (left, right) => right.score - left.score || left.order - right.order;
  return scored.sort((left, right) => (right.contradiction === null) - (left.contradiction === null) || byScore(left, right));
}
