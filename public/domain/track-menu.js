/** @typedef {{ key: string, text: string, checked: boolean, disabled: boolean, kind: "heading" | "radio", level?: string, depth?: number, accessibleText?: string }} TrackMenuItem */

import { menuUpdate } from "./menu-update.js";

/** @param {Array<{ key: string, text?: string, checked?: boolean, disabled?: boolean, kind?: string, level?: string, depth?: number, accessibleText?: string }>} items */
export function trackMenuState(items, { offLabel = "" } = {}) {
  const rows = (Array.isArray(items) ? items : []).map((item) => ({
    key: String(item.key),
    text: String(item.text ?? ""),
    kind: item.kind === "heading" ? "heading" : "radio",
    ...(item.kind === "heading" ? { level: item.level } : {}),
    ...(Number.isInteger(item.depth) ? { depth: item.depth } : {}),
    ...(typeof item.accessibleText === "string" ? { accessibleText: item.accessibleText } : {}),
    checked: item.kind !== "heading" && item.checked === true,
    disabled: item.disabled === true
  }));
  if (!offLabel) return rows;
  const hasChecked = rows.some((item) => item.kind === "radio" && item.checked);
  return [{ key: "", text: offLabel, kind: "radio", checked: !hasChecked, disabled: false }, ...rows];
}

/** @param {string} key @param {string} text @param {string} level @param {number} depth */
export function trackMenuHeading(key, text, level, depth) {
  return { key, text, kind: "heading", level, depth, checked: false, disabled: false };
}

/**
 * Update one keyed menu while preserving existing nodes and focus. Both track
 * menus use the same element attributes and `menuUpdate` diff.
 *
 * @param {HTMLElement} menu
 * @param {TrackMenuItem[]} wanted
 * @param {(item: TrackMenuItem) => HTMLElement} createNode
 */
export function reconcileTrackMenu(menu, wanted, createNode) {
  const elements = new Map();
  const current = [...menu.children]
    .filter((element) => element.dataset?.trackMenuNodeKey !== undefined)
    .map((element) => {
      const key = element.dataset.trackMenuNodeKey;
      elements.set(key, element);
      return {
        key,
        text: element.querySelector?.("[data-track-menu-label]")?.textContent ?? "",
        checked: element.checked === true,
        disabled: element.hasAttribute?.("disabled") === true,
        accessibleText: element.getAttribute?.("aria-label") ?? "",
        depth: Number(element.dataset.trackMenuDepth) || 0,
        level: element.dataset.trackMenuGroup ?? ""
      };
    });
  const comparable = wanted.map((item) => ({
    key: item.key,
    text: item.text,
    checked: item.kind === "radio" && item.checked,
    disabled: item.disabled === true,
    accessibleText: item.accessibleText ?? "",
    depth: item.depth ?? 0,
    level: item.level ?? ""
  }));
  const wantedByKey = new Map(wanted.map((item) => [item.key, item]));
  const { remove, set, create, reorder } = menuUpdate(current, comparable);
  for (const key of remove) elements.get(key)?.remove();
  for (const change of set) {
    const element = elements.get(change.key);
    if ("text" in change) element.querySelector("[data-track-menu-label]").textContent = change.text;
    if ("checked" in change && "checked" in element) element.checked = change.checked;
    if ("disabled" in change) element.toggleAttribute("disabled", change.disabled);
    if ("accessibleText" in change) {
      if (change.accessibleText) element.setAttribute("aria-label", change.accessibleText);
      else element.removeAttribute("aria-label");
    }
    if ("depth" in change) element.dataset.trackMenuDepth = String(change.depth);
    if ("level" in change) {
      if (change.level) element.dataset.trackMenuGroup = change.level;
      else delete element.dataset.trackMenuGroup;
    }
  }
  for (const { item, before } of create) {
    const element = createNode(wantedByKey.get(item.key));
    menu.insertBefore(element, before === null ? null : elements.get(before) ?? null);
    elements.set(item.key, element);
  }
  if (reorder) for (const item of wanted) menu.appendChild(elements.get(item.key));
  for (const item of wanted) {
    const element = elements.get(item.key);
    if (item.kind === "radio" && element.checked !== item.checked) element.checked = item.checked;
  }
}

/** @param {Document} document @param {TrackMenuItem} item */
export function createTrackMenuNode(document, item) {
  const heading = item.kind === "heading";
  const element = document.createElement(heading ? "div" : "media-chrome-menu-item");
  element.dataset.trackMenuNodeKey = item.key;
  element.dataset.trackMenuDepth = String(item.depth ?? 0);
  if (heading) element.dataset.trackMenuGroup = item.level;
  const label = document.createElement("span");
  label.dataset.trackMenuLabel = "";
  label.textContent = item.text;
  element.appendChild(label);
  if (heading) {
    element.setAttribute("role", "presentation");
    return element;
  }
  element.type = "radio";
  element.value = item.key;
  element.dataset.trackMenuKey = item.key;
  if (item.accessibleText) element.setAttribute("aria-label", item.accessibleText);
  element.checked = item.checked === true;
  element.toggleAttribute("disabled", item.disabled === true);
  return element;
}
