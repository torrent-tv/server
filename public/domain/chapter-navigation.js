/** Return chapter entries in source-timeline order, excluding invalid positions. */
export function navigableSections(sections) {
  return (Array.isArray(sections) ? sections : [])
    .filter((section) => typeof section?.id === "string" && Number.isFinite(section.startSeconds) && section.startSeconds >= 0)
    .sort((left, right) => left.startSeconds - right.startSeconds || (left.order ?? 0) - (right.order ?? 0));
}

/** Return timeline intervals clipped to the known media duration. */
export function playbackSectionIntervals(sections, duration) {
  if (!Number.isFinite(duration) || duration <= 0) return [];
  const ordered = navigableSections(sections).filter((section) => section.startSeconds < duration);
  const byId = new Map(ordered.map((section) => [section.id, section]));

  return ordered.flatMap((section, index) => {
    const startSeconds = section.startSeconds;
    if (section.endSeconds !== null && section.endSeconds !== undefined &&
      (!Number.isFinite(section.endSeconds) || section.endSeconds <= startSeconds)) return [];
    const parent = byId.get(section.parentId);
    const nextSibling = ordered.slice(index + 1).find((candidate) => candidate.parentId === section.parentId);
    const explicitEnd = Number.isFinite(section.endSeconds) && section.endSeconds > startSeconds
      ? section.endSeconds
      : null;
    const displayEnd = Number.isFinite(section.displayEndSeconds) && section.displayEndSeconds > startSeconds
      ? section.displayEndSeconds
      : null;
    const siblingEnd = Number.isFinite(nextSibling?.startSeconds) ? nextSibling.startSeconds : null;
    const parentEnd = Number.isFinite(parent?.endSeconds) && parent.endSeconds > startSeconds
      ? parent.endSeconds
      : null;
    const endSeconds = Math.min(
      duration,
      explicitEnd ?? displayEnd ?? siblingEnd ?? duration,
      siblingEnd ?? duration,
      parentEnd ?? duration
    );
    return endSeconds > startSeconds ? [{ ...section, startSeconds, endSeconds }] : [];
  });
}

/** Return the section covering the viewer's current position, or null in a gap. */
export function currentSectionId(sections, currentTime, duration) {
  if (!Number.isFinite(currentTime) || currentTime < 0) return null;
  return playbackSectionIntervals(sections, duration)
    .find((section) => section.startSeconds <= currentTime && currentTime < section.endSeconds)?.id ?? null;
}

/** Return the localized display title used by the chapter list and timeline. */
export function sectionTitle(section) {
  const title = section?.titles?.find((entry) => typeof entry?.text === "string" && entry.text.trim());
  return title?.text.trim() || "Untitled chapter";
}

/** Return a readable chapter label that does not rely on segment color. */
export function sectionLabel(section) {
  const title = sectionTitle(section);
  const type = sectionTypeLabel(section?.type);
  return type === "Chapter" ? title : `${type}: ${title}`;
}

/** Return the chapter type as readable text. */
export function sectionTypeLabel(type) {
  return ({ opening: "Opening", ending: "Ending", credits: "Credits", "post-credits": "Post-credits" })[type] ?? "Chapter";
}

/** Format a media timestamp as m:ss or h:mm:ss. */
export function formatChapterTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return "–:––";
  const total = Math.floor(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const remainder = total % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`
    : `${minutes}:${String(remainder).padStart(2, "0")}`;
}
