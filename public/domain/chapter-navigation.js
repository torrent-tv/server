/** Return chapter entries in source-timeline order, excluding invalid positions. */
export function navigableSections(sections) {
  return (Array.isArray(sections) ? sections : [])
    .filter((section) => typeof section?.id === "string" && Number.isFinite(section.startSeconds) && section.startSeconds >= 0)
    .sort((left, right) => left.startSeconds - right.startSeconds || (left.order ?? 0) - (right.order ?? 0));
}

/** Return the last section that has started at the viewer's current position. */
export function currentSectionId(sections, currentTime) {
  if (!Number.isFinite(currentTime) || currentTime < 0) return null;
  let active = null;
  for (const section of sections) {
    if (section.startSeconds > currentTime) break;
    active = section.id;
  }
  return active;
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
