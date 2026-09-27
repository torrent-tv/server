/**
 * @file The picture as the viewer sees it, in physical pixels (roadmap item 98).
 */

import test from "node:test";
import assert from "node:assert/strict";
import { pictureSizeOf, visiblePictureOf } from "../public/domain/visible-picture.js";

const FILM = { width: 1920, height: 1080 };

function measure(overrides) {
  return visiblePictureOf({
    box: { width: 1000, height: 1000 },
    devicePixels: null,
    devicePixelRatio: 1,
    video: FILM,
    objectFit: "contain",
    objectPosition: "50% 50%",
    ...overrides
  });
}

test("a landscape film on an upright screen is the width and a strip of the height", () => {
  // The window's long and short edges would have asked for 1000 tall.
  assert.deepEqual(measure({ box: { width: 400, height: 800 }, devicePixelRatio: 3 }), { width: 1200, height: 675 });
});

test("the same element turned landscape asks for the height it now shows", () => {
  assert.deepEqual(measure({ box: { width: 800, height: 400 }, devicePixelRatio: 3 }), { width: 2133, height: 1200 });
});

test("physical pixels reported by the browser win over the pixel ratio", () => {
  const size = measure({
    box: { width: 800, height: 450 },
    devicePixels: { width: 1600, height: 900 },
    devicePixelRatio: 1
  });
  assert.deepEqual(size, { width: 1600, height: 900 });
});

test("a cropped frame asks for the whole frame at the scale it is shown", () => {
  // cover on a square box: 1000 tall, 1778 wide, of which 1000 is visible.
  assert.deepEqual(measure({ objectFit: "cover" }), { width: 1778, height: 1000 });
});

test("an offset frame is judged by the part inside the element", () => {
  // none: shown at its own size; pushed so only its left 500 pixels are inside.
  assert.deepEqual(
    measure({ objectFit: "none", objectPosition: "500px 0px", box: { width: 1000, height: 1000 } }),
    { width: 1920, height: 1080 }
  );
});

test("a frame pushed wholly outside the element is nothing to measure", () => {
  assert.equal(measure({ objectFit: "none", objectPosition: "2000px 0px" }), null);
});

test("fill stretches each axis on its own", () => {
  assert.deepEqual(measure({ objectFit: "fill", box: { width: 640, height: 480 } }), { width: 640, height: 480 });
});

test("scale-down never asks for more than the frame", () => {
  assert.deepEqual(measure({ objectFit: "scale-down", box: { width: 3840, height: 2160 } }), FILM);
});

test("nothing is measured before the element or the video has a size", () => {
  assert.equal(measure({ box: { width: 0, height: 300 } }), null);
  assert.equal(measure({ video: { width: 0, height: 0 } }), null);
});

test("a size is a positive width and height", () => {
  assert.deepEqual(pictureSizeOf({ width: 10.4, height: 20.6 }), { width: 10, height: 21 });
  assert.equal(pictureSizeOf({ width: -1, height: 2 }), null);
  assert.equal(pictureSizeOf(null), null);
});
