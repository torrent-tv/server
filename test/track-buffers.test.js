/**
 * @file What each track's own buffer holds, read out of hls.js.
 *
 * The shape is hls.js's and it is not the obvious one: `sourceBuffers` is an
 * array of `[name, SourceBuffer]` pairs, pre-filled with `[null, null]` slots.
 * The first version of this reader assumed an object keyed by name, found
 * `undefined` every time, and silently printed the media element's own range —
 * which is the intersection of the tracks, i.e. the one thing the reader exists
 * to avoid. Nothing failed; the line simply answered a different question.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { describeTrackBuffers } from "../public/domain/hls-player.js";

/**
 * A stand-in for `TimeRanges`.
 *
 * @param {Array<[number, number]>} ranges
 * @returns {{ length: number, start: (i: number) => number, end: (i: number) => number }}
 */
function timeRanges(ranges) {
  return {
    length: ranges.length,
    start: (i) => ranges[i][0],
    end: (i) => ranges[i][1]
  };
}

test("each track's own buffer is named and printed", () => {
  const instance = {
    bufferController: {
      sourceBuffers: [
        ["video", { buffered: timeRanges([[2084.082, 2120.118]]) }],
        ["audio", { buffered: timeRanges([[2082.08, 2086.033]]) }]
      ]
    }
  };
  assert.equal(
    describeTrackBuffers(instance, null),
    "video=[2084.082..2120.118] audio=[2082.080..2086.033]"
  );
});

test("empty slots are skipped, not printed as tracks", () => {
  // hls.js starts with `[[null, null], [null, null]]` and fills the slots in as
  // tracks are created, so a muxed stream leaves one pair empty for the whole
  // session.
  const instance = {
    bufferController: {
      sourceBuffers: [["audiovideo", { buffered: timeRanges([[0, 4]]) }], [null, null]]
    }
  };
  assert.equal(describeTrackBuffers(instance, null), "audiovideo=[0.000..4.000]");
});

test("a buffer detached from its media source says so instead of throwing", () => {
  // `SourceBuffer.buffered` throws `InvalidStateError` once the buffer has been
  // removed — which is the state a dead film is in, i.e. exactly when this is
  // read. A throw here lands in hls.js's own error path and is reported as an
  // internal exception, burying what it was called to show.
  const detached = {
    get buffered() {
      throw new DOMException("removed", "InvalidStateError");
    }
  };
  assert.equal(
    describeTrackBuffers({ bufferController: { sourceBuffers: [["audio", detached]] } }, null),
    "audio=detached"
  );
});

test("with no per-track buffers the media element is used and named as such", () => {
  const media = { buffered: timeRanges([[0, 10]]) };
  assert.equal(
    describeTrackBuffers({}, media),
    "media-intersection=[0.000..10.000]"
  );
});

test("nothing readable at all is unknown, not an exception", () => {
  assert.equal(describeTrackBuffers(null, null), "media-intersection=unknown");
});
