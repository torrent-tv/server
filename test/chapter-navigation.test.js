import test from "node:test";
import assert from "node:assert/strict";
import { currentSectionId, formatChapterTime, navigableSections } from "../public/domain/chapter-navigation.js";

const sections = [
  { id: "late", startSeconds: 65, order: 2 },
  { id: "first", startSeconds: 0, order: 0 },
  { id: "invalid", startSeconds: Number.NaN },
  { id: "middle", startSeconds: 30, order: 1 }
];

test("chapter navigation filters invalid entries and sorts by media time", () => {
  assert.deepEqual(navigableSections(sections).map(({ id }) => id), ["first", "middle", "late"]);
});

test("current chapter follows the last start at or before playback time", () => {
  const ordered = navigableSections(sections);
  assert.equal(currentSectionId(ordered, 0), "first");
  assert.equal(currentSectionId(ordered, 30), "middle");
  assert.equal(currentSectionId(ordered, 90), "late");
  assert.equal(currentSectionId(ordered, -1), null);
  assert.equal(currentSectionId(ordered, Number.NaN), null);
});

test("chapter time uses a compact media timestamp", () => {
  assert.equal(formatChapterTime(83), "1:23");
  assert.equal(formatChapterTime(3723), "1:02:03");
  assert.equal(formatChapterTime(Number.NaN), "–:––");
});
