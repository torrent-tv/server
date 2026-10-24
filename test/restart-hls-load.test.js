import test from "node:test";
import assert from "node:assert/strict";
import { restartLoadAt } from "../public/domain/hls-player.js";

test("restarting a stalled HLS load disables loading before setting its next position", () => {
  const calls = [];
  const instance = {
    stopLoad: () => calls.push("stop"),
    startLoad: position => calls.push(["start", position])
  };

  assert.equal(restartLoadAt(instance, 8), true);
  assert.deepEqual(calls, ["stop", ["start", 8]]);
});

test("an unavailable HLS instance or invalid position is left untouched", () => {
  const calls = [];
  const instance = {
    stopLoad: () => calls.push("stop"),
    startLoad: position => calls.push(["start", position])
  };

  assert.equal(restartLoadAt(null, 8), false);
  assert.equal(restartLoadAt(instance, -1), false);
  assert.equal(restartLoadAt(instance, Number.NaN), false);
  assert.deepEqual(calls, []);
});
