import test from "node:test";
import assert from "node:assert/strict";
import { SeekPosition } from "../public/domain/seek-position.js";

test("a seek stops old loads before reporting and starts only after acknowledgement", async () => {
  const position = new SeekPosition();
  const calls = [];
  let acknowledge;
  const moved = position.move(4868, {
    stopLoad: () => calls.push("stop"),
    reportSeek: target => { calls.push(["report", target]); return new Promise(resolve => { acknowledge = resolve; }); },
    startLoad: target => calls.push(["start", target])
  });
  assert.equal(position.value, 4868);
  assert.deepEqual(calls, ["stop", ["report", 4868]]);
  acknowledge();
  await moved;
  assert.deepEqual(calls.at(-1), ["start", 4868]);
});

test("late replies from rapid seeks cannot restart an earlier destination", async () => {
  const position = new SeekPosition();
  const replies = [];
  const starts = [];
  const actions = {
    stopLoad: () => {},
    reportSeek: () => new Promise(resolve => replies.push(resolve)),
    startLoad: target => starts.push(target)
  };
  const first = position.move(100, actions);
  const last = position.move(500, actions);
  replies[1]();
  await last;
  replies[0]();
  await first;
  assert.deepEqual(starts, [500]);
});

test("changing the file invalidates an outstanding seek", async () => {
  const position = new SeekPosition();
  let acknowledge;
  const starts = [];
  const moved = position.move(500, {
    stopLoad: () => {},
    reportSeek: () => new Promise(resolve => { acknowledge = resolve; }),
    startLoad: target => starts.push(target)
  });
  position.reset(960);
  acknowledge();
  await moved;
  assert.deepEqual(starts, []);
  assert.equal(position.value, 960);
});
