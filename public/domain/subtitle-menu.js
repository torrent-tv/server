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

/**
 * @typedef {object} SubtitleMenuEntry
 * @property {string} key - Stable for the life of the track.
 * @property {string} label - What the track is called now.
 * @property {boolean} showing
 */

/**
 * @typedef {object} SubtitleMenuItem
 * @property {string} key
 * @property {string} text - The label, with an ordinal where another item
 *   carries the same one, so two tracks never look like one.
 * @property {boolean} checked
 */

/**
 * The items, in the order the tracks were added, labels made distinct.
 *
 * @param {SubtitleMenuEntry[]} entries
 * @returns {SubtitleMenuItem[]}
 */
export function subtitleMenuItems(entries) {
  const list = Array.isArray(entries) ? entries : [];
  const totals = new Map();
  for (const entry of list) {
    const label = labelOf(entry);
    totals.set(label, (totals.get(label) ?? 0) + 1);
  }
  const seen = new Map();
  return list.map((entry) => {
    const label = labelOf(entry);
    const ordinal = (seen.get(label) ?? 0) + 1;
    seen.set(label, ordinal);
    return {
      key: entry.key,
      text: totals.get(label) > 1 ? `${label} (${ordinal})` : label,
      checked: entry.showing === true
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
