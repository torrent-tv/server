import { mediaTrackLanguageInfo } from "./track-language.js";
import { trackMenuHeading } from "./track-menu.js";

/**
 * Adapt the loading view's audio inventory to the shared player menu model.
 * Track indices remain the choice keys so playback selection keeps its current
 * contract.
 *
 * @param {Array<object>} tracks
 * @param {number} activeIndex
 */
export function audioMenuItems(tracks, activeIndex = 0) {
  const groups = new Map();
  for (const track of Array.isArray(tracks) ? tracks : []) {
    const language = mediaTrackLanguageInfo(track);
    const group = groups.get(language.code) ?? { ...language, tracks: [] };
    group.tracks.push(track);
    groups.set(language.code, group);
  }

  return [...groups.values()]
    .sort((a, b) => a.unknown - b.unknown || a.name.localeCompare(b.name) || a.code.localeCompare(b.code))
    .flatMap((language) => {
      const multipleLanguages = groups.size > 1;
      if (language.tracks.length > 1) {
        const rows = [trackMenuHeading(`audio-language:${language.code}`, language.name, "language", 0)];
        const choices = language.tracks.map((track) => audioTrackItem(track, language, false, activeIndex));
        const labelCounts = new Map();
        for (const choice of choices) labelCounts.set(choice.text, (labelCounts.get(choice.text) ?? 0) + 1);
        return [
          ...rows,
          ...choices.map((choice) => {
            if (labelCounts.get(choice.text) < 2) return choice;
            const track = language.tracks.find((item) => String(item.index) === choice.key);
            const suffix = `Track ${Number(track?.index ?? 0) + 1}`;
            return {
              ...choice,
              text: `${choice.text} · ${suffix}`,
              accessibleText: `${choice.accessibleText}, ${suffix}`
            };
          })
        ];
      }
      return [audioTrackItem(language.tracks[0], language, multipleLanguages || groups.size === 1, activeIndex)];
    });
}

function audioTrackItem(track, language, includeLanguage, activeIndex) {
  const index = Number.isInteger(track?.index) ? track.index : 0;
  const parts = [];
  if (includeLanguage) parts.push(language.name);
  const team = textOf(track?.naming?.releaser);
  if (team && team !== language.name) parts.push(team);
  const title = language.title;
  if (title && title !== team && !looksLikeLanguageOnlyTitle(title) && !titleRepeatsFlag(title, track)) parts.push(title);
  const details = [];
  if (track?.isCommentary === true) details.push("Commentary");
  if (track?.isVisualImpaired === true) details.push("Audio description");
  if (track?.isOriginal === true && track?.isCommentary !== true) details.push("Original");
  const channels = channelLayoutName(track?.channels);
  if (channels) details.push(channels);
  if (details.length) parts.push(`(${details.join(" · ")})`);
  if (parts.length === 0) parts.push(`Track ${index + 1}`);
  return {
    key: String(index),
    text: parts.join(" · "),
    accessibleText: [language.name, team, title, ...details].filter(Boolean).join(", "),
    kind: "radio",
    depth: 0,
    checked: index === activeIndex,
    disabled: false
  };
}

function looksLikeLanguageOnlyTitle(title) {
  return /^(?:und|[a-z]{2,3}(?:-[a-z0-9]{2,8})*)$/iu.test(title);
}

function titleRepeatsFlag(title, track) {
  const normalized = title.toLowerCase();
  return (track?.isCommentary === true && normalized === "commentary") ||
    (track?.isVisualImpaired === true && /^(?:audio description|visually impaired)$/u.test(normalized)) ||
    (track?.isOriginal === true && normalized === "original");
}

function channelLayoutName(channels) {
  if (channels === 1) return "Mono";
  if (channels === 2) return "Stereo";
  if (channels === 6) return "5.1";
  if (channels === 8) return "7.1";
  if (Number.isSafeInteger(channels) && channels > 0) return `${channels} channels`;
  return "";
}

function textOf(value) {
  return typeof value === "string" ? value.trim() : "";
}
