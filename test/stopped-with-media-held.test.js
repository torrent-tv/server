/**
 * @file When an element that has stopped is stepped so its pipeline reads again.
 *
 * Field 2026-10-22 (torrent-tv/meta#231): hls.js removed the frames the video
 * pipeline was reading, Chrome played the sound on for a second and then
 * waited at 511.36 s for 114 s with 100 s held in both tracks, until the tab
 * was closed. The step is for exactly that: stopped, and every track holding
 * the position. Every other stop has a reason of its own and is left alone.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { stoppedWithMediaHeld } from "../public/domain/hls-player.js";

// The field case at the moment the element started waiting.
const FIELD = {
  paused: false,
  seeking: false,
  ended: false,
  readyState: 2,
  position: 511.364554,
  tracks: [
    [{ start: 510.135, end: 611.361 }],
    [{ start: 475.408, end: 611.348 }]
  ]
};

test("waiting with every track holding the position is a stop with media held", () => {
  assert.equal(stoppedWithMediaHeld(FIELD), true);
});

test("a track that does not hold the position is a wait for media", () => {
  // The picture's track has a hole at the playhead: the loader has to fill it.
  assert.equal(stoppedWithMediaHeld({ ...FIELD, tracks: [[{ start: 512, end: 611 }], FIELD.tracks[1]] }), false);
  // The sound was thrown away for another language and is being fetched again.
  assert.equal(stoppedWithMediaHeld({ ...FIELD, tracks: [FIELD.tracks[0], []] }), false);
});

test("less than a second held beyond the position is a wait for media", () => {
  assert.equal(stoppedWithMediaHeld({ ...FIELD, tracks: [[{ start: 510.135, end: 512.2 }], FIELD.tracks[1]] }), false);
  assert.equal(stoppedWithMediaHeld({ ...FIELD, tracks: [[{ start: 510.135, end: 512.4 }], FIELD.tracks[1]] }), true);
});

test("a pause, a seek and the end stop the element on purpose", () => {
  assert.equal(stoppedWithMediaHeld({ ...FIELD, paused: true }), false);
  assert.equal(stoppedWithMediaHeld({ ...FIELD, seeking: true }), false);
  assert.equal(stoppedWithMediaHeld({ ...FIELD, ended: true }), false);
});

test("an element that has enough to play, or nothing at all, is not stopped with media held", () => {
  assert.equal(stoppedWithMediaHeld({ ...FIELD, readyState: 3 }), false);
  assert.equal(stoppedWithMediaHeld({ ...FIELD, readyState: 4 }), false);
  assert.equal(stoppedWithMediaHeld({ ...FIELD, readyState: 0 }), false);
});

test("without SourceBuffers to read there is nothing to decide on", () => {
  assert.equal(stoppedWithMediaHeld({ ...FIELD, tracks: [] }), false);
  assert.equal(stoppedWithMediaHeld({ ...FIELD, tracks: undefined }), false);
  assert.equal(stoppedWithMediaHeld({ ...FIELD, position: Number.NaN }), false);
});
