/**
 * @file The subtitle menu names tracks by key; labels are only what is shown.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { isTypingTarget, subtitleMenuItems, subtitleToggleKey } from "../public/domain/subtitle-menu.js";

test("an item keeps its key when its label changes, and stays the one checked", () => {
  const before = subtitleMenuItems([{ key: "1:embedded:0", label: "Unknown", showing: true }]);
  const after = subtitleMenuItems([{ key: "1:embedded:0", label: "English", showing: true }]);
  assert.deepEqual(before, [{ key: "1:embedded:0", text: "Unknown", checked: true }]);
  assert.deepEqual(after, [{ key: "1:embedded:0", text: "English", checked: true }]);
});

test("two tracks with one label are two items that cannot be confused", () => {
  const items = subtitleMenuItems([
    { key: "1:embedded:0", label: "English", showing: false },
    { key: "1:embedded:1", label: "English", showing: true },
    { key: "1:sidecar:5", label: "Russian", showing: false }
  ]);
  assert.deepEqual(items.map((item) => [item.key, item.text, item.checked]), [
    ["1:embedded:0", "English (1)", false],
    ["1:embedded:1", "English (2)", true],
    ["1:sidecar:5", "Russian", false]
  ]);
});

test("the subtitles key turns off what is on, and otherwise the last choice, the file's own, or the first", () => {
  const entries = (showing) => [
    { key: "a", label: "A", showing: showing === "a" },
    { key: "b", label: "B", showing: showing === "b" }
  ];
  assert.equal(subtitleToggleKey({ entries: entries("b") }), "", "something is on: off");
  assert.equal(subtitleToggleKey({ entries: entries(null), lastChosenKey: "b", preferredKey: "a" }), "b");
  assert.equal(subtitleToggleKey({ entries: entries(null), preferredKey: "a" }), "a");
  assert.equal(subtitleToggleKey({ entries: entries(null), lastChosenKey: "gone" }), "a", "a key from another file is not used");
  assert.equal(subtitleToggleKey({ entries: [] }), "");
});

test("a key pressed while typing is not the page's", () => {
  assert.equal(isTypingTarget({ tagName: "INPUT" }), true);
  assert.equal(isTypingTarget({ tagName: "textarea" }), true);
  assert.equal(isTypingTarget({ tagName: "DIV", isContentEditable: true }), true);
  assert.equal(isTypingTarget({ tagName: "MEDIA-CONTROLLER" }), false);
  assert.equal(isTypingTarget(null), false);
});
