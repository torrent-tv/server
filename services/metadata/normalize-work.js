/** Keep provider records separate from the values selected for presentation. */
export function normalizeWork(tmdb, anilist = null) {
  const sources = {};
  if (tmdb) sources.tmdb = tmdb;
  if (anilist) sources.anilist = anilist;
  const title = tmdb?.title || anilist?.title?.english || anilist?.title?.romaji || anilist?.title?.native;
  return {
    sources,
    normalized: {
      kind: (tmdb?.kind ?? (anilist?.format === "MOVIE" ? "movie" : "tv")) === "movie" ? "movie" : "series",
      title,
      originalTitle: tmdb?.originalTitle || anilist?.title?.native || null,
      year: tmdb?.year ?? anilist?.startDate?.year ?? null,
      isAnime: anilist ? true : tmdb?.anime === true ? true : null,
      overview: tmdb?.overview ?? null,
      poster: tmdb?.poster ?? null,
      backdrop: tmdb?.backdrop ?? null,
      images: (tmdb?.images ?? []).map(({ kind, ...image }) => ({ ...image, role: kind, source: "tmdb" })),
      seasons: tmdb?.seasons ?? [],
      provenance: {
        title: tmdb?.title ? "tmdb" : anilist ? "anilist" : null,
        originalTitle: tmdb?.originalTitle ? "tmdb" : anilist?.title?.native ? "anilist" : null,
        year: tmdb?.year != null ? "tmdb" : anilist?.startDate?.year != null ? "anilist" : null,
        isAnime: anilist ? "anilist" : tmdb?.anime ? "tmdb" : null,
        overview: tmdb ? "tmdb" : null, poster: tmdb ? "tmdb" : null, backdrop: tmdb ? "tmdb" : null,
        images: tmdb ? "tmdb" : null, seasons: tmdb ? "tmdb" : null
      }
    }
  };
}
