/**
 * @file What the browser's buffer says, and how fast it is filling.
 *
 * These two numbers gate everything the viewer is told about a wait, and both
 * have been wrong in the field in ways nobody could see: a proxy reporting
 * "100%" over a player whose buffer was 0.0 s is the measurement that moved
 * every progress figure onto this side. So they are pinned here rather than
 * trusted.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { bufferedAheadSeconds, fillRateFromSamples, withSample } from "../public/domain/buffer-metrics.js";

/**
 * A stand-in for the media element: only `currentTime` and `buffered` are read.
 *
 * @param {number} currentTime
 * @param {Array<[number, number]>} ranges - Buffered [start, end] pairs.
 * @returns {object}
 */
function video(currentTime, ranges) {
  return {
    currentTime,
    buffered: {
      length: ranges.length,
      start: (index) => ranges[index][0],
      end: (index) => ranges[index][1]
    }
  };
}

test("what is buffered ahead is measured from the range holding the playhead", () => {
  assert.equal(bufferedAheadSeconds(video(10, [[0, 25]])), 15);
});

test("a range after a gap does not count", () => {
  // The picture cannot reach it without the gap being filled, so counting it
  // would promise a cushion over a player that is about to stop.
  assert.equal(bufferedAheadSeconds(video(10, [[0, 12], [40, 90]])), 2);
});

test("nothing buffered at the playhead is zero, not an error", () => {
  assert.equal(bufferedAheadSeconds(video(30, [[0, 12]])), 0);
  assert.equal(bufferedAheadSeconds(video(0, [])), 0);
});

test("a range starting a few frames late still counts", () => {
  // The element's reported position and the range's start routinely differ by
  // less than a frame; treating that as a gap would report an empty buffer
  // during ordinary playback.
  assert.equal(Math.round(bufferedAheadSeconds(video(10, [[10.2, 25]]))), 15);
});

test("no element at all is zero", () => {
  assert.equal(bufferedAheadSeconds(null), 0);
  assert.equal(bufferedAheadSeconds({}), 0);
});

test("a fill rate needs enough samples to have a slope", () => {
  const now = 10_000;
  assert.equal(fillRateFromSamples([], now), null, "nothing measured yet is not a rate of zero");
  assert.equal(fillRateFromSamples([{ atMs: now, aheadSeconds: 1 }], now), null);
  assert.equal(
    fillRateFromSamples([{ atMs: now - 1000, aheadSeconds: 1 }, { atMs: now, aheadSeconds: 2 }], now),
    null,
    "two samples is one interval, and one interval is the length of a segment"
  );
});

test("a buffer holding steady while the picture plays is filling at 1x, not 0", () => {
  const now = 10_000;
  const samples = [
    { atMs: now - 4000, aheadSeconds: 10 },
    { atMs: now - 2000, aheadSeconds: 10 },
    { atMs: now, aheadSeconds: 10 }
  ];
  assert.equal(fillRateFromSamples(samples, now), 1);
});

test("a buffer growing by four seconds over four is filling at 2x", () => {
  const now = 10_000;
  const samples = [
    { atMs: now - 4000, aheadSeconds: 6 },
    { atMs: now - 2000, aheadSeconds: 8 },
    { atMs: now, aheadSeconds: 10 }
  ];
  assert.equal(fillRateFromSamples(samples, now), 2);
});

test("a buffer losing ground reads below 1", () => {
  const now = 10_000;
  const samples = [
    { atMs: now - 4000, aheadSeconds: 10 },
    { atMs: now - 2000, aheadSeconds: 8 },
    { atMs: now, aheadSeconds: 6 }
  ];
  assert.equal(fillRateFromSamples(samples, now), 0);
});

test("samples older than the window say nothing about the rate now", () => {
  const now = 100_000;
  const stale = [
    { atMs: now - 90_000, aheadSeconds: 0 },
    { atMs: now - 80_000, aheadSeconds: 30 },
    { atMs: now - 70_000, aheadSeconds: 60 }
  ];
  assert.equal(fillRateFromSamples(stale, now), null, "a rate from a minute ago is not a rate");
});

test("adding a sample drops the ones that have aged out and does not mutate", () => {
  // The first is outside the window at the moment of the new sample; the
  // second is inside it. A sample exactly ON the edge counts as inside, which
  // is why this one is a second past it rather than exactly on it.
  const original = [{ atMs: -1_000, aheadSeconds: 1 }, { atMs: 9_000, aheadSeconds: 2 }];
  const next = withSample(original, { atMs: 10_000, aheadSeconds: 3 });
  assert.equal(original.length, 2, "the input array must not be modified");
  assert.deepEqual(
    next.map((sample) => sample.atMs),
    [9_000, 10_000],
    "the sample from ten seconds back is outside the window"
  );
});
