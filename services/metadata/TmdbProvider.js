/**
 * @file TMDB as a metadata provider.
 *
 * The questions TMDB is asked, and the order they are asked in, belong to
 * `MetadataService`; this class gives that service the shape the registry
 * works with, and reduces a TMDB work to the common fields.
 */

import { CATEGORY, EVIDENCE, MetadataProvider, STAGE } from "./MetadataProvider.js";

/**
 * A TMDB work reduced to the common fields. A field TMDB does not state is
 * `undefined`, so the next source in the order of that field supplies it.
 *
 * @param {object} tmdb
 * @returns {Record<string, unknown>}
 */
export function tmdbFields(tmdb) {
  return {
    kind: tmdb.kind === undefined ? undefined : tmdb.kind === "movie" ? "movie" : "series",
    title: tmdb.title || undefined,
    originalTitle: tmdb.originalTitle || undefined,
    year: tmdb.year ?? undefined,
    isAnime: tmdb.anime === true ? true : undefined,
    overview: tmdb.overview ?? null,
    poster: tmdb.poster ?? null,
    backdrop: tmdb.backdrop ?? null,
    images: (tmdb.images ?? []).map(({ kind, ...image }) => ({ ...image, role: kind, source: "tmdb" })),
    seasons: tmdb.seasons ?? []
  };
}

/** @param {{ status: string, work?: object }} answer */
function withRecords(answer) {
  return { ...answer, records: answer.status === "identified" && answer.work ? { tmdb: answer.work } : {} };
}

export class TmdbProvider extends MetadataProvider {
  #service;

  /** @param {import("./MetadataService.js").MetadataService} service */
  constructor(service) {
    super({ name: "tmdb", stage: STAGE.primary, takes: [EVIDENCE.names, EVIDENCE.externalIds], category: CATEGORY.general });
    this.#service = service;
  }

  async identify(request) {
    return withRecords(await this.#service.identify(request));
  }

  async identifyById(request) {
    if (!this.#service.identifyById) return null;
    return withRecords(await this.#service.identifyById(request));
  }

  async lastResort(request) {
    if (!this.#service.identifyTransliterated) return null;
    return withRecords(await this.#service.identifyTransliterated(request));
  }

  get supportsEpisodes() {
    return true;
  }

  episodes(request) {
    return this.#service.episodes(request);
  }

  fields(record) {
    return tmdbFields(record);
  }
}