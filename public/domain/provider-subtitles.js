/** Use confirmed catalogue episodes, never equate TMDB and AniList numbering. */
function subtitleSearchText(file) {
  const path = typeof file?.relativePath === "string" ? file.relativePath : file?.name;
  if (typeof path !== "string") return null;
  const name = path.split(/[\\/]/u).at(-1)?.replace(/\.[^.]+$/u, "")
    .replace(/[._]+/gu, " ").replace(/\s+/gu, " ").trim().toLowerCase().slice(0, 300);
  return name || null;
}

export function providerSubtitleQuery(state, fileIndex) {
  const work = state?.pictures?.[fileIndex] ?? state?.work;
  const searchText = subtitleSearchText(state?.files?.[fileIndex]);
  const fingerprint = state?.fingerprints?.[fileIndex];
  const exactFingerprint = fingerprint && /^[0-9a-f]{16}$/u.test(fingerprint.hash ?? "") &&
    Number.isSafeInteger(fingerprint.size) && fingerprint.size >= 131072
    ? { hash: fingerprint.hash, size: fingerprint.size }
    : null;
  const fallback = exactFingerprint ? { fingerprint: exactFingerprint, ...(searchText ? { query: searchText } : {}) } : null;
  if (!work) return fallback;
  const normalized = work.normalized ?? work;
  const tmdbId = work.sources?.tmdb?.tmdbId ?? normalized.tmdbId ?? null;
  const anilistId = work.sources?.anilist?.id ?? normalized.anilistId ?? null;
  if (!tmdbId && !anilistId) return fallback;
  if (normalized.kind === "movie") {
    const imdbId = work.sources?.tmdb?.imdbId ?? normalized.imdbId;
    return { kind: "movie", tmdbId, anilistId, ...(exactFingerprint ? { fingerprint: exactFingerprint } : {}),
      ...(/^tt\d{1,12}$/u.test(imdbId ?? "") ? { imdbId } : {}) };
  }
  const match = state.episodes?.[fileIndex];
  const query = { kind: "series", tmdbId: null, anilistId: null, ...(exactFingerprint ? { fingerprint: exactFingerprint } : {}) };
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
  return query.tmdbId || query.anilistId ? query : fallback;
}

export function providerSubtitleLabel(item) {
  let language;
  try { language = item.language === "und" ? "Unknown language" : new Intl.DisplayNames(["en"], { type: "language" }).of(item.language); }
  catch {
    // silent-ok: an unknown provider language tag is displayed as supplied.
    language = item.language;
  }
  return language;
}

/** Keep unsuitable releases out per language, with unknown offers as fallback. */
export function filterSubtitleOffers(items) {
  const languages = new Map();
  for (const item of items) {
    const language = typeof item.language === "string" ? item.language : "und";
    const group = languages.get(language) ?? [];
    group.push(item);
    languages.set(language, group);
  }
  const visible = [];
  const excludedLanguages = [];
  for (const [language, group] of languages) {
    const suitable = group.filter(item => item.eligibility === "suitable");
    const unknown = group.filter(item => item.eligibility !== "suitable" && item.eligibility !== "incompatible");
    visible.push(...suitable, ...unknown);
    if (!suitable.length && !unknown.length) excludedLanguages.push(language);
  }
  return { items: visible, excludedLanguages };
}
