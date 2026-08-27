/**
 * @file The rule that decides whether a subtitle track has anything to draw
 * where the viewer is — and, with it, whether the reading repeats.
 *
 * It exists because the rule was wrong twice. First it asked "is anything on
 * screen", which is false through every pause in the dialogue and would have
 * printed once a second for the length of a film. Then it asked "does the track
 * hold anything AHEAD", which hid the very failure it was written for: the
 * field track held cues from 3356 s while the viewer sat at 3192 s, so there
 * was always something ahead while nothing could be drawn for 165 s in either
 * direction (`research/subtitle-delay-2026-08-26.md`).
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readCoverage, describeCoverage } from "../public/domain/subtitle-coverage.js";

/** @param {number} start @param {number} end @returns {{ startTime: number, endTime: number }} */
const cue = (start, end) => ({ startTime: start, endTime: end });

test("a pause between two lines is not a track with nothing to say", () => {
  const cues = [cue(10, 12), cue(30, 32)];

  const coverage = readCoverage(cues, 20);

  assert.equal(coverage.covering, 0, "nothing is on screen at 20 s");
  assert.equal(coverage.unsupplied, false, "but the playhead is inside what the track holds");
  assert.equal(coverage.nextAhead, 30);
});

test("a cue covering the playhead is supplied", () => {
  const coverage = readCoverage([cue(10, 12), cue(30, 32)], 11);

  assert.equal(coverage.covering, 1);
  assert.equal(coverage.unsupplied, false);
});

test("the field failure: everything held sits ahead of the viewer", () => {
  // The track held 134 cues spanning 3356.7-4371.5 s with the playhead at
  // 3192 s. Judged on "is anything ahead" this read as healthy.
  const cues = [cue(3356.7, 3360.0), cue(3400.0, 3403.0), cue(4368.0, 4371.5)];

  const coverage = readCoverage(cues, 3192);

  assert.equal(coverage.covering, 0);
  assert.notEqual(coverage.nextAhead, null, "there IS something ahead");
  assert.equal(coverage.unsupplied, true, "and the viewer still has nothing to read");
});

test("a track holding nothing at all is unsupplied", () => {
  assert.equal(readCoverage([], 100).unsupplied, true);
  assert.equal(readCoverage(null, 100).unsupplied, true, "null is what a disabled track reads as");
  assert.equal(readCoverage(undefined, 100).count, 0);
});

test("one cue: inside it is supplied, either side of it is not", () => {
  const one = [cue(50, 55)];

  assert.equal(readCoverage(one, 52).unsupplied, false);
  assert.equal(readCoverage(one, 49).unsupplied, true, "before the only cue");
  assert.equal(readCoverage(one, 60).unsupplied, true, "past the only cue");
});

test("the end of what a track holds is the latest END, not the last entry's", () => {
  // Ordered by START, as `TextTrackCueList` is: a sign held over the dialogue
  // begins earlier and finishes later than the line after it.
  const cues = [cue(100, 140), cue(110, 112)];

  const coverage = readCoverage(cues, 130);

  assert.equal(coverage.last, 140);
  assert.equal(coverage.covering, 1, "the long sign covers 130 s");
  assert.equal(coverage.unsupplied, false);
});

test("a seek backwards out of what the track holds reads as unsupplied", () => {
  const cues = [cue(3000, 3002), cue(3010, 3012)];

  assert.equal(readCoverage(cues, 3005).unsupplied, false, "still inside the held stretch");
  assert.equal(readCoverage(cues, 500).unsupplied, true, "seeked back to a region never walked");
});

test("the signature ignores the clock, so a still track is not reported twice", () => {
  const cues = [cue(10, 12), cue(30, 32)];

  const atOne = readCoverage(cues, 20);
  const atTwo = readCoverage(cues, 21);
  assert.equal(atOne.signature, atTwo.signature, "the playhead moved and nothing else did");

  const withMore = readCoverage([...cues, cue(40, 42)], 21);
  assert.notEqual(atTwo.signature, withMore.signature, "a cue arrived");

  const covered = readCoverage(cues, 31);
  assert.notEqual(atTwo.signature, covered.signature, "a cue came on screen");
});

test("the line names the figures a reader needs", () => {
  const coverage = readCoverage([cue(3356.7, 3360)], 3192);

  const line = describeCoverage("mode change", "Russian (FULL- rezka)", coverage, 3192, 12.5);

  assert.match(line, /cues=1/);
  assert.match(line, /span=3356\.7-3360\.0s/);
  assert.match(line, /playhead=3192\.0s/);
  assert.match(line, /covering=0/);
  assert.match(line, /next=164\.7s ahead/);
  assert.match(line, /unsuppliedFor=12\.5s/);
});

test("a supplied track's line carries no wait", () => {
  const coverage = readCoverage([cue(10, 20)], 15);

  assert.doesNotMatch(describeCoverage("push", "English", coverage, 15, null), /unsuppliedFor/);
});
