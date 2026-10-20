import test from "node:test";
import assert from "node:assert/strict";
import {
  currentSectionId,
  formatChapterTime,
  navigableSections,
  playbackSectionIntervals,
  sectionLabel
} from "../public/domain/chapter-navigation.js";

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
  assert.equal(currentSectionId(ordered, 0, 100), "first");
  assert.equal(currentSectionId(ordered, 30, 100), "middle");
  assert.equal(currentSectionId(ordered, 90, 100), "late");
  assert.equal(currentSectionId(ordered, -1, 100), null);
  assert.equal(currentSectionId(ordered, Number.NaN, 100), null);
  assert.equal(currentSectionId(ordered, 30, Number.NaN), null);
});

test("chapter intervals keep declared gaps and clip overlaps to the next sibling", () => {
  const source = [
    { id: "first", startSeconds: 0, endSeconds: 20, order: 0 },
    { id: "second", startSeconds: 10, endSeconds: 12, order: 1 },
    { id: "third", startSeconds: 15, order: 2 }
  ];
  const intervals = playbackSectionIntervals(source, 30);
  assert.deepEqual(intervals.map(({ id, startSeconds, endSeconds }) => [id, startSeconds, endSeconds]), [
    ["first", 0, 10], ["second", 10, 12], ["third", 15, 30]
  ]);
  assert.equal(currentSectionId(source, 13, 30), null);
  assert.equal(currentSectionId(source, 15, 30), "third");
});

test("chapter intervals respect a declared parent end and keep short final sections", () => {
  const source = [
    { id: "parent", startSeconds: 0, endSeconds: 20, order: 0 },
    { id: "child-a", parentId: "parent", startSeconds: 5, displayEndSeconds: 100, order: 1 },
    { id: "child-b", parentId: "parent", startSeconds: 10, displayEndSeconds: 100, order: 2 },
    { id: "post", startSeconds: 29.5, endSeconds: 30, type: "post-credits", order: 3 }
  ];
  const intervals = playbackSectionIntervals(source, 30);
  assert.deepEqual(intervals.map(({ id, startSeconds, endSeconds }) => [id, startSeconds, endSeconds]), [
    ["parent", 0, 20], ["child-a", 5, 10], ["child-b", 10, 20], ["post", 29.5, 30]
  ]);
  assert.equal(sectionLabel(source[3]), "Post-credits: Untitled chapter");
});

test("invalid intervals are omitted and unknown duration produces no timeline cues", () => {
  const source = [
    { id: "bad", startSeconds: 4, endSeconds: 3, displayEndSeconds: 9 },
    { id: "outside", startSeconds: 15, endSeconds: 20 }
  ];
  assert.deepEqual(playbackSectionIntervals(source, 10), []);
  assert.deepEqual(playbackSectionIntervals(source, Infinity), []);
});

test("chapter time uses a compact media timestamp", () => {
  assert.equal(formatChapterTime(83), "1:23");
  assert.equal(formatChapterTime(3723), "1:02:03");
  assert.equal(formatChapterTime(Number.NaN), "–:––");
});
