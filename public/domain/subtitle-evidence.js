/** Only explicit header metadata is evidence; dialogue and subtitle language are excluded. */
export function subtitleEvidenceOf(vtt, kindHint) {
  const note = String(vtt).slice(0, 16384).match(/(?:^|\n)NOTE TORRENT-TV-METADATA\r?\n([^\r\n]+)/u);
  if (!note) return null;
  try {
    const metadata = JSON.parse(note[1]);
    const titles = [...(Array.isArray(metadata.titles) ? metadata.titles : []),
      ...(kindHint === "movie" && Array.isArray(metadata.genericTitles) ? metadata.genericTitles : [])]
      .filter(title => typeof title === "string" && title.length > 1 && title.length <= 160).slice(0, 4);
    const years = (Array.isArray(metadata.years) ? metadata.years : [])
      .filter(year => Number.isInteger(year) && year >= 1888 && year <= 2100).slice(0, 4);
    return titles.length || years.length ? { titles, years } : null;
  } catch {
    // silent-ok: a note that is not valid JSON states no titles or years, and
    // null is that answer; the subtitle file comes from the torrent, not from us.
    return null;
  }
}
