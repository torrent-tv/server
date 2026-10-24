import test from "node:test";
import assert from "node:assert/strict";
import { restartLoadAt } from "../public/domain/hls-player.js";

test("restarting a stalled HLS load sets its next position", () => {
  const calls = [];
  const instance = {
    inFlightFragments: { main: null, audio: null },
    startLoad: position => calls.push(["start", position])
  };

  assert.equal(restartLoadAt(instance, 8), true);
  assert.deepEqual(calls, [["start", 8]]);
});

test("a prebuffer nudge leaves an in-flight segment request alone", () => {
  const calls = [];
  const instance = {
    inFlightFragments: { main: { frag: { sn: 3 } }, audio: null },
    startLoad: position => calls.push(["start", position])
  };

  assert.equal(restartLoadAt(instance, 12), false);
  assert.deepEqual(calls, []);
});

test("an unavailable HLS instance or invalid position is left untouched", () => {
  const calls = [];
  const instance = {
    inFlightFragments: { main: null, audio: null },
    startLoad: position => calls.push(["start", position])
  };

  assert.equal(restartLoadAt(null, 8), false);
  assert.equal(restartLoadAt(instance, -1), false);
  assert.equal(restartLoadAt(instance, Number.NaN), false);
  assert.deepEqual(calls, []);
});
