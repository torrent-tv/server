/** Use confirmed catalogue episodes, never equate TMDB and AniList numbering. */
export function providerSubtitleQuery(state, fileIndex) {
  const work = state?.pictures?.[fileIndex] ?? state?.work;
  if (!work) return null;
  const normalized = work.normalized ?? work;
  const tmdbId = work.sources?.tmdb?.tmdbId ?? normalized.tmdbId ?? null;
  const anilistId = work.sources?.anilist?.id ?? normalized.anilistId ?? null;
  if (!tmdbId && !anilistId) return null;
  if (normalized.kind === "movie") {
    const imdbId = work.sources?.tmdb?.imdbId ?? normalized.imdbId;
    return { kind: "movie", tmdbId, anilistId, ...(/^tt\d{1,12}$/u.test(imdbId ?? "") ? { imdbId } : {}) };
  }
  const match = state.episodes?.[fileIndex];
  const query = { kind: "series", tmdbId: null, anilistId: null };
  if (tmdbId && match?.episodes?.length === 1 && match.part == null) {
    Object.assign(query, { tmdbId, season: match.season, episode: match.episodes[0].number });
  }
  // An AniList-only work is already the individual anime season. A regular,
  // unseasoned release number can be used within that record. A TMDB season
  // number is not evidence about its correspondence to AniList.
  const marker = state.markers?.[fileIndex];
  if (anilistId && !tmdbId && marker?.season == null && !marker?.special && marker?.part == null && marker?.episodes?.length === 1) {
    Object.assign(query, { anilistId, anilistEpisode: marker.episodes[0] });
  }
  return query.tmdbId || query.anilistId ? query : null;
}

export function providerSubtitleLabel(item) {
  const name = { opensubtitles: "OpenSubtitles", jimaku: "Jimaku" }[item.provider] ?? item.provider;
  let language;
  try { language = item.language === "und" ? "Unknown language" : new Intl.DisplayNames(["en"], { type: "language" }).of(item.language); }
  catch {
    // silent-ok: an unknown provider language tag is displayed as supplied.
    language = item.language;
  }
  const details = [item.forced ? "forced" : null, item.hearingImpaired ? "SDH" : null, item.episodeGuess ? "episode from filename" : null].filter(Boolean);
  return `${language} · ${name}${item.release ? ` · ${item.release}` : ""}${details.length ? ` (${details.join(", ")})` : ""}`;
}
