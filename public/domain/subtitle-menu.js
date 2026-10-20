/**
 * @file The subtitle menu as a list of keyed items — what it shows and which
 * track a choice turns on.
 *
 * **A menu item names its track by a key that never changes, not by its
 * label.** media-chrome's captions menu remembered each track by its label and
 * language and found it again by both when the viewer chose it. A track's label
 * does change — it opens as "Unknown" and becomes a language when the text has
 * been read — and once it had, the item matched no track at all: choosing it
 * turned nothing on (field 2026-10-01, Chrome 157: zero `change` events, the
 * item matching zero tracks). Two tracks with one label matched each other's
 * items the same way, and choosing one showed both.
 *
 * Pure: no DOM. The component that owns the tracks makes the keys and holds
 * the tracks; the view renders these items and reports the key chosen.
 */

import { languageName, trackLanguageCode } from "./track-language.js";

/**
 * A single menu: "Off", visual language/team headings, then selectable tracks.
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
 * @property {string} label - Fallback display label for old metadata.
 * @property {string} [language]
 * @property {string} [team]
 * @property {string} [variant]
 * @property {string[]} [details]
 * @property {number} [order]
 * @property {boolean} showing
 */

/**
 * @typedef {object} SubtitleMenuItem
 * @property {string} key
 * @property {string} text
 * @property {boolean} checked
 * @property {"heading" | "radio"} kind
 * @property {"language" | "team"} [level]
 * @property {string} [accessibleText]
 */

/**
 * Tracks are grouped in one menu by language and explicit team. Missing team
 * metadata adds no team heading; the track follows its language heading.
 *
 * @param {SubtitleMenuEntry[]} entries
 * @returns {SubtitleMenuItem[]}
 */
export function subtitleMenuItems(entries, statuses = []) {
  const list = Array.isArray(entries) ? entries : [];
  const languages = new Map();
  for (const entry of list) {
    const language = languageParts(entry.language);
    const group = languages.get(language.code) ?? { ...language, teams: new Map(), order: entry.order ?? languages.size };
    const team = typeof entry.team === "string" && entry.team.trim() ? entry.team.trim() : "";
    const tracks = group.teams.get(team) ?? [];
    tracks.push(entry);
    group.teams.set(team, tracks);
    languages.set(language.code, group);
  }
  const grouped = [...languages.values()]
    .sort((a, b) => a.unknown - b.unknown || a.name.localeCompare(b.name) || a.code.localeCompare(b.code))
    .flatMap((language) => {
      const rows = [{
        key: `language:${encodeURIComponent(language.code)}`,
        text: language.name,
        kind: "heading",
        level: "language",
        checked: false
      }];
      const teams = [...language.teams.entries()].sort(([a], [b]) => a === "" ? 1 : b === "" ? -1 : a.localeCompare(b));
      for (const [team, tracks] of teams) {
        if (team) rows.push({
          key: `team:${encodeURIComponent(language.code)}:${encodeURIComponent(team)}`,
          text: team,
          kind: "heading",
          level: "team",
          checked: false
        });
        rows.push(...variantItems(tracks, language.name, team));
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

function languageParts(value) {
  const tag = typeof value === "string" ? value.trim() : "";
  const code = trackLanguageCode(tag) || "und";
  const unknown = code === "und" || code === "";
  const name = unknown ? "Unknown language" : languageName(code) || code;
  return { code: unknown ? "und" : code, name, unknown: unknown ? 1 : 0 };
}

function variantItems(tracks, language, team) {
  const ordered = [...tracks].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const prepared = ordered.map((entry) => {
    const details = Array.isArray(entry.details) ? entry.details.filter(Boolean) : [];
    const tag = typeof entry.language === "string" ? entry.language.trim() : "";
    if (tag && /[-_][a-z]{2}$/iu.test(tag)) details.push(tag);
    const variant = typeof entry.variant === "string" ? entry.variant.trim() : "";
    const text = [variant, ...details].filter(Boolean).join(" · ") || labelOf(entry);
    return { entry, text };
  });
  const totals = new Map();
  for (const item of prepared) totals.set(item.text, (totals.get(item.text) ?? 0) + 1);
  const seen = new Map();
  return prepared.map(({ entry, text }) => {
    const ordinal = (seen.get(text) ?? 0) + 1;
    seen.set(text, ordinal);
    return {
      key: String(entry.key),
      text: totals.get(text) > 1 ? `${text} (${ordinal})` : text,
      accessibleText: [language, team, totals.get(text) > 1 ? `${text} (${ordinal})` : text].filter(Boolean).join(", "),
      kind: "radio",
      checked: entry.showing === true,
      disabled: entry.disabled === true
    };
  });
}

/**
 * Which track the subtitles key should turn on, or "" to turn them off.
 *
 * Off when anything is showing. Otherwise the track the viewer chose last in
 * this file, else the one the page would open with by its own rules (the
 * remembered choice or the container's default), else the first.
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

/**
 * @param {SubtitleMenuEntry} entry
 * @returns {string}
 */
function labelOf(entry) {
  const label = typeof entry?.label === "string" ? entry.label.trim() : "";
  return label.length > 0 ? label : "Unknown";
}
