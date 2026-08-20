/**
 * @file Reading WebVTT into cues, and adding only the ones a track lacks.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { appendCues, parseVttCues } from "../public/domain/vtt-cues.js";

const SAMPLE = `WEBVTT

1
00:00:01.500 --> 00:00:03.000
First line

2
00:00:04.250 --> 00:00:06.000
Second line
over two rows
`;

test("cues are read with their times and their text", () => {
  const cues = parseVttCues(SAMPLE);

  assert.equal(cues.length, 2);
  assert.deepEqual(cues[0], { startSeconds: 1.5, endSeconds: 3, text: "First line" });
  assert.equal(cues[1].startSeconds, 4.25);
  assert.equal(cues[1].text, "Second line\nover two rows", "a cue keeps the rows it was written with");
});

test("an hour-long film's timestamps are read as hours", () => {
  const cues = parseVttCues("WEBVTT\n\n01:02:03.400 --> 01:02:05.000\nLate in the film\n");

  assert.equal(cues[0].startSeconds, 3723.4);
});

test("anything that is not WebVTT gives no cues rather than throwing", () => {
  assert.deepEqual(parseVttCues("<html>not this</html>"), []);
  assert.deepEqual(parseVttCues(""), []);
  assert.deepEqual(parseVttCues(null), []);
});

test("a cue that ends before it starts is dropped, because the player refuses it", () => {
  const cues = parseVttCues("WEBVTT\n\n00:00:05.000 --> 00:00:04.000\nBackwards\n");

  assert.deepEqual(cues, []);
});

test("only cues the track does not have are added", () => {
  const added = [];
  const track = { addCue: (cue) => added.push(cue) };
  globalThis.VTTCue = class {
    constructor(start, end, text) {
      Object.assign(this, { startTime: start, endTime: end, text });
    }
  };

  const first = appendCues(track, parseVttCues(SAMPLE), -1);
  assert.equal(first.added, 2);
  assert.equal(first.knownUntilSeconds, 4.25);

  // The proxy sends what it has read so far, so the same cues come back.
  const again = appendCues(track, parseVttCues(SAMPLE), first.knownUntilSeconds);
  assert.equal(again.added, 0, "a cue already on screen is not added twice");
  assert.equal(added.length, 2);
});

test("a malformed cue does not stop the ones after it", () => {
  const added = [];
  const track = {
    addCue: (cue) => {
      if (cue.text === "bad") {
        throw new Error("refused");
      }
      added.push(cue);
    }
  };
  globalThis.VTTCue = class {
    constructor(start, end, text) {
      Object.assign(this, { startTime: start, endTime: end, text });
    }
  };

  const result = appendCues(track, [
    { startSeconds: 1, endSeconds: 2, text: "bad" },
    { startSeconds: 3, endSeconds: 4, text: "good" }
  ], -1);

  assert.equal(result.added, 1);
  assert.equal(added[0].text, "good");
});
