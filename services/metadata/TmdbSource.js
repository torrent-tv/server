/**
 * @file TMDB as a source of works, seasons and images.
 *
 * Every request goes through one {@link RequestGate}; every answer is read with
 * a byte limit and reduced to the fields this product shows, so what is kept —
 * and what the cache holds — is small whatever TMDB sent.
 *
 * A `429` pauses the whole source for as long as `Retry-After` says. The request
 * that received it is tried once more, and only if the pause ends before its
 * own deadline; everything else waiting is refused by the gate at once.
 */

import { readBoundedBody } from "./bounded-body.js";
import { MetadataUnavailableError } from "./RequestGate.js";

const API_ROOT = "https://api.themoviedb.org/3";

/** Largest answer read for a search or a work, in bytes. */
const MAX_WORK_BYTES = 512 * 1024;

/** Largest answer read for one season, in bytes. */
const MAX_SEASON_BYTES = 1024 * 1024;

/** How long to pause when a `429` states no `Retry-After`. A stated limit, not a measurement. */
const DEFAULT_PAUSE_MS = 10_000;

/**
 * One search result, reduced.
 *
 * @typedef {object} SearchResult
 * @property {number} id
 * @property {string} name - The title in the requested language.
 * @property {string} originalName - The title in the work's own language.
 * @property {number | null} year - From the first air date or the release date.
 */

/**
 * @typedef {object} Work
 * @property {"tv" | "movie"} kind
 * @property {number} tmdbId
 * @property {string} title
 * @property {string} originalTitle
 * @property {number | null} year
 * @property {string} overview
 * @property {string | null} poster - TMDB file name, e.g. `abc.jpg`.
 * @property {string | null} backdrop
 * @property {Array<{ number: number, name: string, episodeCount: number }>} seasons
 */

/**
 * @typedef {object} Season
 * @property {number} number
 * @property {string} name
 * @property {Array<{ number: number, name: string, still: string | null }>} episodes
 */

/**
 * The year a TMDB date string starts with.
 *
 * @param {unknown} date
 * @returns {number | null}
 */
function yearOf(date) {
  const match = /^(\d{4})-/.exec(String(date ?? ""));
  return match ? Number(match[1]) : null;
}

/**
 * A TMDB image path reduced to its file name: `/abc.jpg` → `abc.jpg`.
 *
 * @param {unknown} path
 * @returns {string | null}
 */
function imageFile(path) {
  const match = /^\/([A-Za-z0-9]+\.(?:jpg|png))$/.exec(String(path ?? ""));
  return match ? match[1] : null;
}

/**
 * @param {Response} response
 * @param {number} now
 * @returns {number} When the pause ends.
 */
function pauseEnd(response, now) {
  const header = response.headers.get("retry-after");
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return now + seconds * 1000;
  }
  const date = Date.parse(header ?? "");
  return Number.isFinite(date) ? date : now + DEFAULT_PAUSE_MS;
}

export class TmdbSource {
  /** @type {string} */
  #token;

  /** @type {typeof fetch} */
  #fetch;

  /** @type {import("./RequestGate.js").RequestGate} */
  #gate;

  /** @type {() => number} */
  #now;

  /**
   * @param {object} params
   * @param {string} params.token - TMDB API Read Access Token.
   * @param {import("./RequestGate.js").RequestGate} params.gate
   * @param {typeof fetch} [params.fetch]
   * @param {() => number} [params.now]
   */
  constructor({ token, gate, fetch = globalThis.fetch, now = Date.now }) {
    this.#token = token;
    this.#gate = gate;
    this.#fetch = fetch;
    this.#now = now;
  }

  /**
   * One page of a title search.
   *
   * @param {"tv" | "movie"} kind
   * @param {string} query
   * @param {string} language
   * @param {number} page
   * @param {{ deadlineAt: number }} options
   * @returns {Promise<{ results: SearchResult[], totalPages: number }>}
   */
  async search(kind, query, language, page, options) {
    const body = await this.#get(`/search/${kind}`, { query, language, page: String(page), include_adult: "false" }, MAX_WORK_BYTES, options);
    const results = Array.isArray(body?.results) ? body.results : [];
    return {
      totalPages: Number.isInteger(body?.total_pages) ? body.total_pages : 0,
      results: results
        .filter((result) => Number.isInteger(result?.id))
        .map((result) => ({
          id: result.id,
          name: String((kind === "tv" ? result.name : result.title) ?? ""),
          originalName: String((kind === "tv" ? result.original_name : result.original_title) ?? ""),
          year: yearOf(kind === "tv" ? result.first_air_date : result.release_date)
        }))
    };
  }

  /**
   * One work, reduced to what is shown.
   *
   * @param {"tv" | "movie"} kind
   * @param {number} id
   * @param {string} language
   * @param {{ deadlineAt: number }} options
   * @returns {Promise<Work>}
   */
  async work(kind, id, language, options) {
    const body = await this.#get(`/${kind}/${id}`, { language, append_to_response: "images,keywords", include_image_language: "en,null" }, MAX_WORK_BYTES, options);
    const seasons = kind === "tv" && Array.isArray(body?.seasons) ? body.seasons : [];
    return {
      kind,
      tmdbId: id,
      title: String((kind === "tv" ? body?.name : body?.title) ?? ""),
      originalTitle: String((kind === "tv" ? body?.original_name : body?.original_title) ?? ""),
      year: yearOf(kind === "tv" ? body?.first_air_date : body?.release_date),
      imdbId: /^tt\d+$/u.test(body?.imdb_id ?? "") ? body.imdb_id : null,
      runtimeSeconds: kind === "movie" && Number.isFinite(body?.runtime) && body.runtime > 0 ? body.runtime * 60 : null,
      episodeRuntimeSeconds: kind === "tv" ? (body?.episode_run_time ?? []).filter(minutes => Number.isFinite(minutes) && minutes > 0).map(minutes => minutes * 60) : [],
      overview: String(body?.overview ?? ""),
      poster: imageFile(body?.poster_path),
      backdrop: imageFile(body?.backdrop_path),
      anime: [...(body?.keywords?.keywords ?? []), ...(body?.keywords?.results ?? [])].some(k => String(k.name).toLowerCase() === "anime"),
      images: [
        ...(body?.images?.backdrops ?? []).map(i => ({ ...i, kind: "backdrop" })),
        ...(body?.images?.posters ?? []).map(i => ({ ...i, kind: "poster" }))
      ].filter(i => imageFile(i.file_path) && Number.isInteger(i.width) && i.width > 0 && Number.isInteger(i.height) && i.height > 0)
        .sort((a, b) => (b.iso_639_1 === "en") - (a.iso_639_1 === "en") || (b.vote_average ?? 0) - (a.vote_average ?? 0))
        .filter((image, index, all) => all.slice(0, index).filter(i => i.kind === image.kind).length < 6).map(i => ({ file: imageFile(i.file_path), width: i.width, height: i.height, kind: i.kind })),
      seasons: seasons
        .filter((season) => Number.isInteger(season?.season_number))
        .map((season) => ({
          number: season.season_number,
          name: String(season.name ?? ""),
          episodeCount: Number.isInteger(season.episode_count) ? season.episode_count : 0
        }))
    };
  }

  /**
   * Every alternative title the provider holds for one work — the spellings it
   * was released or transliterated under (`Trudno byt' bogom`, `Hauru no Ugoku
   * Shiro`). The same for every language, so the answer is not keyed by one.
   *
   * @param {"tv" | "movie"} kind
   * @param {number} id
   * @param {{ deadlineAt: number }} options
   * @returns {Promise<string[]>}
   */
  async alternativeTitles(kind, id, options) {
    const body = await this.#get(`/${kind}/${id}/alternative_titles`, {}, MAX_WORK_BYTES, options);
    const entries = Array.isArray(kind === "tv" ? body?.results : body?.titles) ? (kind === "tv" ? body.results : body.titles) : [];
    return entries.map((entry) => String(entry?.title ?? "")).filter((title) => title.length > 0);
  }

  /**
   * One season of a series, reduced to its episodes.
   *
   * @param {number} id
   * @param {number} number
   * @param {string} language
   * @param {{ deadlineAt: number }} options
   * @returns {Promise<Season>}
   */
  async season(id, number, language, options) {
    const body = await this.#get(`/tv/${id}/season/${number}`, { language }, MAX_SEASON_BYTES, options);
    const episodes = Array.isArray(body?.episodes) ? body.episodes : [];
    return {
      number,
      name: String(body?.name ?? ""),
      episodes: episodes
        .filter((episode) => Number.isInteger(episode?.episode_number))
        .map((episode) => ({
          number: episode.episode_number,
          name: String(episode.name ?? ""),
          still: imageFile(episode.still_path)
        }))
    };
  }

  /**
   * @param {string} path
   * @param {Record<string, string>} params
   * @param {number} maxBytes
   * @param {{ deadlineAt: number }} options
   * @returns {Promise<any>}
   */
  async #get(path, params, maxBytes, { deadlineAt }) {
    const url = `${API_ROOT}${path}?${new URLSearchParams(params)}`;
    const attempt = () =>
      this.#gate.run(async () => {
        const remaining = deadlineAt - this.#now();
        if (remaining <= 0) {
          throw new MetadataUnavailableError("the deadline passed");
        }
        let response;
        try {
          response = await this.#fetch(url, {
            headers: { Authorization: `Bearer ${this.#token}`, Accept: "application/json" },
            signal: AbortSignal.timeout(remaining)
          });
        } catch (error) {
          throw new MetadataUnavailableError(`the provider did not answer (${error?.name ?? "error"})`);
        }
        if (response.status === 429) {
          await response.body?.cancel().catch(() => {});
          this.#gate.pause(pauseEnd(response, this.#now()));
          return { rateLimited: true };
        }
        if (!response.ok) {
          await response.body?.cancel().catch(() => {});
          throw new MetadataUnavailableError(`the provider answered ${response.status}`);
        }
        const bytes = await readBoundedBody(response, maxBytes);
        try {
          return { body: JSON.parse(bytes.toString("utf8")) };
        } catch {
          throw new MetadataUnavailableError("the provider's answer is not JSON");
        }
      }, { deadlineAt });

    const first = await attempt();
    if (!first.rateLimited) {
      return first.body;
    }
    // One more attempt, and only when the pause ends inside this request's own
    // time: a retry that cannot finish in time only adds to the queue.
    const resumeAt = this.#gate.pausedUntil;
    if (resumeAt >= deadlineAt) {
      throw new MetadataUnavailableError("the provider asked us to pause");
    }
    if (resumeAt > 0) {
      await new Promise((resolve) => {
        setTimeout(resolve, resumeAt - this.#now()).unref?.();
      });
    }
    const second = await attempt();
    if (second.rateLimited) {
      throw new MetadataUnavailableError("the provider asked us to pause");
    }
    return second.body;
  }
}
