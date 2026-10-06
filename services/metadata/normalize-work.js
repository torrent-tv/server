/**
 * @file The common format of a work, and which source states each field of it.
 *
 * Every source keeps its own record; `fields` of its provider reduces a record
 * to the fields below. {@link mergeRecords} takes, for each field, the first
 * source of {@link FIELD_PRIORITY} that states it, and records which one it was.
 * Preference between sources is therefore a statement about a field, never about
 * a source as a whole.
 */

import { anilistFields } from "./AniListProvider.js";
import { tmdbFields } from "./TmdbProvider.js";

/**
 * The sources in the order they are preferred, per field. A source not listed
 * for a field never supplies it. The media container ranks after the databases
 * for what is shown: it is evidence for them, not a replacement. A container
 * title that is only a release name is not stated at all.
 */
export const FIELD_PRIORITY = Object.freeze({
  kind: ["tmdb", "anilist", "container"],
  title: ["tmdb", "anilist", "container"],
  originalTitle: ["tmdb", "anilist", "container"],
  year: ["tmdb", "anilist", "container"],
  isAnime: ["anilist", "tmdb"],
  overview: ["tmdb"],
  poster: ["tmdb"],
  backdrop: ["tmdb"],
  images: ["tmdb"],
  seasons: ["tmdb"]
});

/** What a field holds when no source states it. */
const ABSENT = Object.freeze({
  kind: "series", title: null, originalTitle: null, year: null, isAnime: null,
  overview: null, poster: null, backdrop: null, images: [], seasons: []
});

/**
 * Combine the records of several sources into one work.
 *
 * @param {Array<{ source: string, record: object, fields: Record<string, unknown> }>} entries
 * @returns {{ sources: Record<string, object>, normalized: Record<string, unknown> }}
 */
export function mergeRecords(entries) {
  const sources = {};
  for (const { source, record } of entries) sources[source] = record;
  const normalized = {};
  const provenance = {};
  for (const [field, order] of Object.entries(FIELD_PRIORITY)) {
    let chosen = null;
    for (const source of order) {
      const entry = entries.find((candidate) => candidate.source === source);
      if (entry && entry.fields[field] !== undefined) {
        chosen = { source, value: entry.fields[field] };
        break;
      }
    }
    normalized[field] = chosen ? chosen.value : ABSENT[field];
    provenance[field] = chosen ? chosen.source : null;
  }
  normalized.provenance = provenance;
  return { sources, normalized };
}

/** Keep provider records separate from the values selected for presentation. */
export function normalizeWork(tmdb, anilist = null) {
  const entries = [];
  if (tmdb) entries.push({ source: "tmdb", record: tmdb, fields: tmdbFields(tmdb) });
  if (anilist) entries.push({ source: "anilist", record: anilist, fields: anilistFields(anilist) });
  return mergeRecords(entries);
}