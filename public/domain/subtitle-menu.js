/**
 * @file The subtitle menu names tracks by key; labels are only what is shown.
 */

import { subtitleLanguageInfo } from "./track-language.js";

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
 * @property {string} [provider]
 * @property {string} [trackTitle]
 * @property {string} [release]
 * @property {string} [uploaderName]
 * @property {string} [uploadDate]
 * @property {number | null} [cueCount]
 * @property {number | null} [downloads]
 * @property {boolean} [aiTranslated]
 * @property {boolean} [forced]
 * @property {boolean} [hearingImpaired]
 * @property {boolean} [machineTranslated]
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
    const language = languageParts(entry);
    const group = languages.get(language.code) ?? { ...language, tracks: [] };
    group.tracks.push(entry);
    languages.set(language.code, group);
  }

  const grouped = [...languages.values()]
    .sort((a, b) => a.unknown - b.unknown || a.name.localeCompare(b.name) || a.code.localeCompare(b.code))
    .flatMap((language) => {
      if (language.tracks.length === 1) {
        const entry = language.tracks[0];
        const details = trackDetails(entry, language.tracks, false);
        const text = details.length ? `${language.name} (${details.join(" · ")})` : language.name;
        return [trackItem(entry, language.name, [], text, 0)];
      }
      const rows = [heading(`language:${language.code}`, language.name, "language", 0)];
      const sources = groupBy(language.tracks, entry => textOf(entry.source) || "Subtitles")
        .sort((a, b) => sourceRank(a.name) - sourceRank(b.name));
      for (const source of sources) rows.push(...sourceItems(source.items, language, sources, language.tracks));
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

function sourceItems(tracks, language, sources, languageTracks) {
  const source = textOf(tracks[0]?.source) || "Subtitles";
  const localSource = source === "In container" || source === "In torrent";
  const showSource = sources.length > 1 && !localSource && tracks.length > 1;
  const sourceLabels = showSource ? [source] : [];
  const sourceDepth = showSource ? 2 : 1;
  const sourceRows = showSource
    ? [heading(`source:${encodeURIComponent(language.code)}:${encodeURIComponent(source)}`, source, "source", 1)]
    : [];
  const teams = groupBy(tracks, entry => teamOf(entry));
  const teamsDiffer = teams.length > 1;
  const rows = [...sourceRows];
  for (const group of teams) {
    const team = group.name;
    if (teamsDiffer && team && group.items.length > 1) {
      rows.push(heading(`team:${encodeURIComponent(language.code)}:${encodeURIComponent(source)}:${encodeURIComponent(team)}`, team, "team", sourceDepth));
      rows.push(...trackItems(group.items, language, [...sourceLabels, team], sourceDepth + 1, group.items, false));
      continue;
    }
    const parentLabels = [...sourceLabels, ...(teamsDiffer && team && group.items.length > 1 ? [team] : [])];
    const collapsedSource = sources.length > 1 && !showSource && group.items.length === 1;
    const comparison = collapsedSource ? languageTracks : teamsDiffer ? tracks : group.items;
    rows.push(...trackItems(group.items, language, parentLabels, sourceDepth, comparison, teamsDiffer && Boolean(team), collapsedSource));
  }
  return rows;
}

function trackItems(tracks, language, parentLabels, depth, comparison = tracks, includeTeam = false, includeSource = false) {
  return tracks.map(entry => {
    const details = trackDetails(entry, comparison, includeTeam, includeSource);
    const text = details.join(" · ") || language.name;
    return trackItem(entry, language.name, parentLabels, text, depth);
  });
}

function trackDetails(entry, comparison, includeTeam, includeSource) {
  const entries = Array.isArray(comparison) ? comparison : [entry];
  const distinguishingFields = [
    ["cueCount", item => Number.isSafeInteger(item.cueCount) && item.cueCount >= 0 ? `${item.cueCount.toLocaleString()} cues` : "", true],
    ["kind", item => subtitleKinds(item).join(" · "), false],
    ["team", teamOf, false],
    ["edition", item => releaseEdition(item.release), false],
    ["ai", item => item.aiTranslated === true ? "AI-translated" : "", false],
    ["machine", item => item.machineTranslated === true ? "Machine-translated" : "", false]
  ];
  const fallbackFields = [
    ["uploader", item => textOf(item.uploaderName) ? `Uploaded by ${textOf(item.uploaderName)}` : "", false],
    ["downloads", item => Number.isSafeInteger(item.downloads) && item.downloads >= 0 ? `${item.downloads.toLocaleString()} downloads` : "", true],
    ["date", item => uploadDateLabel(item.uploadDate), false],
    ["source", item => textOf(item.source) && item.source !== "In container" && item.source !== "In torrent" ? textOf(item.source) : "", false]
  ];
  const labels = [];
  const signatures = entries.map(() => []);
  const addFields = (fields, onlyWhileDuplicates) => {
    for (const [name, valueOf, requireComplete] of fields) {
      if (onlyWhileDuplicates && !hasDuplicateSignatures(signatures)) break;
      if (name === "team" && !includeTeam) continue;
      if (name === "source" && !includeSource) continue;
      const values = entries.map(item => valueOf(item));
      if (requireComplete && values.some(value => !value)) continue;
      if (new Set(values).size < 2) continue;
      if (onlyWhileDuplicates && !values.some((value, left) => values.some((other, right) => left < right && value !== other && signatures[left].every((item, index) => item === signatures[right][index])))) continue;
      values.forEach((value, index) => signatures[index].push(value));
      const value = valueOf(entry);
      if (value) labels.push(value);
    }
  };
  addFields(distinguishingFields, false);
  addFields(fallbackFields, true);
  return labels;
}

function hasDuplicateSignatures(signatures) {
  return signatures.some((signature, index) => signatures.slice(index + 1).some(other => signature.every((value, valueIndex) => value === other[valueIndex])));
}

function subtitleKinds(entry) {
  const kinds = [];
  const titleParts = textOf(entry.trackTitle).split("|").map(part => part.trim()).filter(Boolean);
  const titleKinds = new Set();
  for (const part of titleParts) {
    const kind = part.toLowerCase();
    if (kind === "forced") titleKinds.add("Signs and foreign dialogue");
    else if (kind === "full") titleKinds.add("Full dialogue");
    else if (kind === "sdh") titleKinds.add("Dialogue and sound descriptions");
    else if (/^(?:signs and foreign dialogue|foreign parts only)$/iu.test(part)) titleKinds.add("Signs and foreign dialogue");
    else if (/^(?:full dialogue)$/iu.test(part)) titleKinds.add("Full dialogue");
    else if (/^(?:dialogue and sound descriptions)$/iu.test(part)) titleKinds.add("Dialogue and sound descriptions");
  }
  if (entry.forced === true) titleKinds.add("Signs and foreign dialogue");
  if (entry.hearingImpaired === true) titleKinds.add("Dialogue and sound descriptions");
  kinds.push(...titleKinds);
  return kinds;
}

function teamOf(entry) {
  if (textOf(entry.team) && !isGenericTrackPart(textOf(entry.team))) return textOf(entry.team);
  const parts = textOf(entry.trackTitle).split("|").map(part => part.trim()).filter(Boolean);
  const team = parts.find(part => !isGenericTrackPart(part));
  return team ?? "";
}

function isGenericTrackPart(value) {
  return /^(?:forced|full|full dialogue|sdh|standard|default|no description|subtitle|subtitles|unknown|signs and foreign dialogue|foreign parts only|dialogue and sound descriptions)(?:\s*\(?\d+\)?)?$/iu.test(textOf(value));
}

function releaseEdition(release) {
  const name = textOf(release);
  if (/\b(?:uhd[._ -]*)?(?:blu[._ -]?ray|bdrip)\b/iu.test(name)) return /\buhd\b/iu.test(name) ? "UHD Blu-ray" : "Blu-ray";
  if (/\b(?:web[._ -]?(?:dl|rip))\b/iu.test(name)) return "Streaming";
  if (/\b(?:hdtv|pdtv)\b/iu.test(name)) return "TV";
  if (/\bdvd(?:rip)?\b/iu.test(name)) return "DVD";
  if (/\b(?:telesync|telecine|camrip|cam)\b/iu.test(name)) return "Cinema recording";
  return "";
}

function uploadDateLabel(value) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) return "";
  return `Uploaded ${new Date(value).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "medium" })}`;
}

function trackItem(entry, language, parentLabels, text, depth) {
  const accessibleParts = [language, ...parentLabels].filter(Boolean);
  if (!accessibleParts.includes(text)) accessibleParts.push(text);
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

function heading(key, text, level, depth) {
  return { key, text, kind: "heading", level, depth, checked: false };
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

function languageParts(entry) {
  const info = subtitleLanguageInfo(entry.language, entry.provider);
  return { ...info, unknown: info.unknown ? 1 : 0 };
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
