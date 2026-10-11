import test from "node:test";
import assert from "node:assert/strict";
import { menuUpdate } from "../public/domain/menu-update.js";
import { subtitleMenuState } from "../public/domain/subtitle-menu.js";

const item = (key, text = key, checked = false, disabled = false) => ({ key, text, checked, disabled });
// The field case: "Off", the film's tracks and a provider's offers (339 in all).
const offers = (count) => Array.from({ length: count }, (_, n) => item(`1:provider:os:${n}`, `Offer ${n}`));

test("an identical publication changes nothing", () => {
  const menu = [item(""), item("t1"), ...offers(330)];
  assert.deepEqual(menuUpdate(menu, menu.map((entry) => ({ ...entry }))), { remove: [], set: [], create: [], reorder: false });
});

test("a mode change writes checked on the two items whose choice moved, and nothing else", () => {
  const menu = [item("", "Off", true), item("t1"), item("t2"), ...offers(330)];
  const wanted = [item("", "Off", false), item("t1", "t1", true), item("t2"), ...offers(330)];
  assert.deepEqual(menuUpdate(menu, wanted), {
    remove: [],
    set: [{ key: "", checked: false }, { key: "t1", checked: true }],
    create: [],
    reorder: false
  });
});

test("appended offers are created at their place and the items already there stay", () => {
  const menu = [item(""), item("t1"), item("1:status:os")];
  const wanted = [item(""), item("t1"), ...offers(2), item("1:status:os")];
  assert.deepEqual(menuUpdate(menu, wanted), {
    remove: [],
    set: [],
    create: [
      { item: offers(2)[0], before: "1:status:os" },
      { item: offers(2)[1], before: "1:status:os" }
    ],
    reorder: false
  });
});

test("an item at the end is created after the last one", () => {
  const result = menuUpdate([item(""), item("t1")], [item(""), item("t1"), item("t2")]);
  assert.deepEqual(result.create, [{ item: item("t2"), before: null }]);
  assert.equal(result.reorder, false);
});

test("a withdrawn item is the only one removed", () => {
  const result = menuUpdate([item(""), item("t1"), item("t2")], [item(""), item("t2")]);
  assert.deepEqual(result, { remove: ["t1"], set: [], create: [], reorder: false });
});

test("a new label or a disabled item is written alone", () => {
  const result = menuUpdate([item(""), item("t1", "Unknown")], [item(""), item("t1", "Russian", false, true)]);
  assert.deepEqual(result.set, [{ key: "t1", text: "Russian", disabled: true }]);
});

test("items kept in another order ask for a reorder", () => {
  const result = menuUpdate([item(""), item("t1"), item("t2")], [item(""), item("t2"), item("t1")]);
  assert.equal(result.reorder, true);
  assert.deepEqual(result.remove, []);
  assert.deepEqual(result.create, []);
});

test("Off is checked exactly when no track is", () => {
  assert.deepEqual(subtitleMenuState([{ key: "t1", text: "English", checked: false }])[0], item("", "Off", true));
  assert.deepEqual(subtitleMenuState([{ key: "t1", text: "English", checked: true }]), [
    item("", "Off", false),
    item("t1", "English", true)
  ]);
  assert.deepEqual(subtitleMenuState([{ key: "s", text: "os: search unavailable — retry", checked: false, disabled: true }])[1],
    item("s", "os: search unavailable — retry", false, true));
});
