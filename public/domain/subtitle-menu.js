/**
 * @file The subtitle menu names tracks by key; labels are only what is shown.
 */

import { languageName, trackLanguageCode } from "./track-language.js";

/**
 * A single menu: "Off" and the supplied language, source, team and track rows.
 *
 * @param {{ key: string, text?: string, checked?: boolean, disabled?: boolean, kind?: string }[]} items
 * @returns {import("./menu-update.js").MenuItemState[]}
 */
export function subtitleMenuState(items) {
  return [
    { key: "", text: "Off", kind: "radio", checked: !hasChecked(items), disabled: false },
    ...items.map((item) => ({
      ...item,
      key: String(item.key),
      text: String(item.text ?? ""),
      kind: item.kind ?? "radio",
      checked: item.checked === true,
      disabled: item.disabled === true
    }))
  ];
}

function hasChecked(items) {
  return Array.isArray(items) && items.some((item) => item.checked === true);
}

/**
 * @typedef {object} SubtitleMenuEntry
 * @property {string} key - Stable for the life of the track.
 * @property {string} [language]
 * @property {string} [source]
 * @property {string} [team]
 * @property {boolean} [forced]
 * @property {boolean} [hearingImpaired]
 * @property {boolean} showing
 */

/**
 * @typedef {object} SubtitleMenuItem
 * @property {string} key
 * @property {string} text
 * @property {boolean} checked
 * @property {"heading" | "radio"} kind
 * @property {"language" | "source" | "team"} [level]
 * @property {string} [accessibleText]
 * @property {number} [depth]
 */

/**
 * Show hierarchy only where it distinguishes choices. A lone track is the
 * language row; singleton source and team levels become selectable rows.
 *
 * @param {SubtitleMenuEntry[]} entries
 * @returns {SubtitleMenuItem[]}
 */
export function subtitleMenuItems(entries, statuses = []) {
  const languages = new Map();
  for (const entry of Array.isArray(entries) ? entries : []) {
    const language = languageParts(entry.language);
    const group = languages.get(language.code) ?? { ...language, tracks: [] };
    group.tracks.push(entry);
    languages.set(language.code, group);
  }

  const grouped = [...languages.values()]
    .sort((a, b) => a.unknown - b.unknown || a.name.localeCompare(b.name) || a.code.localeCompare(b.code))
    .flatMap((language) => {
      if (language.tracks.length === 1) {
        return [trackItem(language.tracks[0], language.name, [], language.name, 0)];
      }
      const rows = [heading(`language:${language.code}`, language.name, "language")];
      const sources = groupBy(language.tracks, entry => textOf(entry.source) || "Subtitles")
        .sort((a, b) => sourceRank(a.name) - sourceRank(b.name));
      if (sources.length === 1) {
        rows.push(...sourceItems(sources[0].items, language, false));
      } else {
        for (const source of sources) {
          rows.push(...sourceItems(source.items, language, true));
        }
      }
      return rows;
    });

  const actions = Array.isArray(statuses) ? statuses.map((item) => ({
    key: String(item.key),
    text: String(item.text ?? ""),
    kind: "radio",
    checked: false,
    disabled: item.disabled === true
  })) : [];
  return [...grouped, ...actions];
}

function sourceItems(tracks, language, showSource) {
  const source = textOf(tracks[0]?.source) || "Subtitles";
  const sources = showSource ? [heading(`source:${encodeURIComponent(language.code)}:${encodeURIComponent(source)}`, source, "source")] : [];
  const teams = groupBy(tracks, entry => textOf(entry.team));
  if (teams.length === 1) {
    const team = teams[0].name;
    if (tracks.length === 1 && showSource) {
      return [trackItem(tracks[0], language.name, [], source, 1)];
    }
    return [...sources, ...trackItems(tracks, language, [...(showSource ? [source] : []), ...(team ? [team] : [])], showSource ? 2 : 1)];
  }

  const rows = [...sources];
  for (const group of teams) {
    if (group.items.length === 1) {
      rows.push(trackItem(group.items[0], language.name, [source, group.name].filter(Boolean), group.name || "Subtitle", showSource ? 2 : 1));
    } else {
      if (group.name) rows.push(heading(`team:${encodeURIComponent(language.code)}:${encodeURIComponent(source)}:${encodeURIComponent(group.name)}`, group.name, "team"));
      rows.push(...trackItems(group.items, language, [source, ...(group.name ? [group.name] : [])], (showSource ? 2 : 1) + (group.name ? 1 : 0)));
    }
  }
  return rows;
}

function trackItems(tracks, language, parentLabels, depth) {
  const forcedDiffers = new Set(tracks.map(track => track.forced === true)).size > 1;
  const sdhDiffers = new Set(tracks.map(track => track.hearingImpaired === true)).size > 1;
  const prepared = tracks.map(entry => {
    const labels = [];
    if (forcedDiffers && entry.forced === true) labels.push("Forced");
    if (sdhDiffers && entry.hearingImpaired === true) labels.push("SDH");
    return { entry, text: labels.join(" · ") || "Subtitle" };
  });
  const totals = new Map();
  for (const item of prepared) totals.set(item.text, (totals.get(item.text) ?? 0) + 1);
  const seen = new Map();
  return prepared.map(({ entry, text }) => {
    const ordinal = (seen.get(text) ?? 0) + 1;
    seen.set(text, ordinal);
    const label = totals.get(text) > 1 ? `${text} (${ordinal})` : text;
    return trackItem(entry, language.name, parentLabels, label, depth);
  });
}

function trackItem(entry, language, parentLabels, text, depth) {
  const accessibleParts = [language, ...parentLabels].filter(Boolean);
  if (accessibleParts.at(-1) !== text) accessibleParts.push(text);
  return {
    key: String(entry.key),
    text,
    accessibleText: accessibleParts.join(", "),
    depth,
    kind: "radio",
    checked: entry.showing === true,
    disabled: entry.disabled === true
  };
}

function heading(key, text, level) {
  return { key, text, kind: "heading", level, checked: false };
}

function groupBy(items, nameOf) {
  const groups = new Map();
  for (const item of items) {
    const name = nameOf(item);
    const group = groups.get(name) ?? [];
    group.push(item);
    groups.set(name, group);
  }
  return [...groups].map(([name, groupedItems]) => ({ name, items: groupedItems }));
}

function textOf(value) {
  return typeof value === "string" ? value.trim() : "";
}

function sourceRank(source) {
  return source === "In container" ? 0 : source === "In torrent" ? 1 : 2;
}

function languageParts(value) {
  const tag = typeof value === "string" ? value.trim() : "";
  const code = trackLanguageCode(tag) || "und";
  const unknown = code === "und" || code === "";
  const name = unknown ? "Unknown language" : languageName(code) || code;
  return { code: unknown ? "und" : code, name, unknown: unknown ? 1 : 0 };
}

/**
 * Which track the subtitles key should turn on, or "" to turn them off.
 *
 * @param {{ entries: SubtitleMenuEntry[], lastChosenKey?: string | null, preferredKey?: string | null }} params
 * @returns {string}
 */
export function subtitleToggleKey({ entries, lastChosenKey = null, preferredKey = null }) {
  const list = Array.isArray(entries) ? entries : [];
  if (list.length === 0 || list.some((entry) => entry.showing === true)) {
    return "";
  }
  const keys = new Set(list.map((entry) => entry.key));
  if (lastChosenKey && keys.has(lastChosenKey)) {
    return lastChosenKey;
  }
  if (preferredKey && keys.has(preferredKey)) {
    return preferredKey;
  }
  return list[0].key;
}

/**
 * Whether a key press belongs to the page and not to something being typed.
 *
 * @param {EventTarget | null} target
 * @returns {boolean}
 */
export function isTypingTarget(target) {
  const element = /** @type {any} */ (target);
  if (!element || typeof element.tagName !== "string") {
    return false;
  }
  const tag = element.tagName.toLowerCase();
  return tag === "input" || tag === "textarea" || tag === "select" || element.isContentEditable === true;
}
