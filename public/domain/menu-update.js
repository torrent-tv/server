/**
 * @file What has to change in a menu of keyed items for it to show a published
 * list, so that a publication pays for what changed and not for every item
 * (torrent-tv/meta#178).
 *
 * The subtitle menu was re-created whole on every publication, and it is
 * published on every text-track `change`. With a subtitle provider's 330
 * offers in it, one publication was 339 element constructions, their template
 * parsing, `media-controller`'s mutation callback and a layout: 620–780 ms of
 * the page's main thread, eight times in a row while a film's embedded tracks
 * loaded (field 2026-10-11, Chrome performance trace). A mode change alters
 * one or two items' `checked`.
 *
 * The menu's current state is read from its elements by the caller, never kept
 * beside them: media-chrome changes `checked` itself when an item is clicked.
 */

/**
 * @typedef {object} MenuItemState
 * @property {string} key
 * @property {string} text
 * @property {boolean} checked
 * @property {boolean} disabled
 * @property {string} [accessibleText]
 * @property {number} [depth]
 * @property {string} [level]
 */

/**
 * The operations that turn the menu's items into the wanted ones.
 *
 * 1. `remove` — keys no longer wanted;
 * 2. `set` — for an item kept, only the properties that differ;
 * 3. `create` — new items, each with the key of the kept item it goes before
 *    (`null`: after the last one);
 * 4. `reorder` — the kept items are not in the wanted order, so every item has
 *    to be put in order again. False whenever their order is unchanged, which
 *    is what keeps the elements where they are.
 *
 * An identical list gives no operation at all.
 *
 * @param {MenuItemState[]} current - The menu's items, in the menu's order.
 * @param {MenuItemState[]} wanted - The published items, in their order.
 * @returns {{ remove: string[], set: ({ key: string } & Partial<MenuItemState>)[], create: { item: MenuItemState, before: string | null }[], reorder: boolean }}
 */
export function menuUpdate(current, wanted) {
  const currentByKey = new Map(current.map((item) => [item.key, item]));
  const wantedKeys = new Set(wanted.map((item) => item.key));
  const remove = current.filter((item) => !wantedKeys.has(item.key)).map((item) => item.key);
  const keptInMenu = current.filter((item) => wantedKeys.has(item.key)).map((item) => item.key);
  const keptWanted = wanted.filter((item) => currentByKey.has(item.key)).map((item) => item.key);
  const reorder = keptInMenu.some((key, position) => key !== keptWanted[position]);
  // For each position, the first kept item after it: where a new item goes.
  const keptAfter = new Array(wanted.length).fill(null);
  for (let position = wanted.length - 2; position >= 0; position--) {
    const next = wanted[position + 1];
    keptAfter[position] = currentByKey.has(next.key) ? next.key : keptAfter[position + 1];
  }
  const set = [];
  const create = [];
  for (let position = 0; position < wanted.length; position++) {
    const item = wanted[position];
    const now = currentByKey.get(item.key);
    if (!now) {
      create.push({ item, before: keptAfter[position] });
      continue;
    }
    const change = { key: item.key };
    if (now.text !== item.text) change.text = item.text;
    if (now.checked !== item.checked) change.checked = item.checked;
    if (now.disabled !== item.disabled) change.disabled = item.disabled;
    if ((now.accessibleText ?? "") !== (item.accessibleText ?? "")) change.accessibleText = item.accessibleText ?? "";
    if ((now.depth ?? 0) !== (item.depth ?? 0)) change.depth = item.depth ?? 0;
    if ((now.level ?? "") !== (item.level ?? "")) change.level = item.level ?? "";
    if (Object.keys(change).length > 1) set.push(change);
  }
  return { remove, set, create, reorder };
}
