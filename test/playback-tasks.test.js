import assert from "node:assert/strict";
import test from "node:test";
import { PlaybackTasks } from "../public/domain/playback-tasks.js";

test("selection cancels immediately, waits for cleanup and starts only the latest file", async () => {
  const tasks = new PlaybackTasks();
  const events = [];
  let finish;
  const first = tasks.replace(async () => {
    events.push("first");
    await new Promise((resolve) => { finish = resolve; });
    events.push("cleanup");
  }, () => {});
  await Promise.resolve();
  await Promise.resolve();
  const second = tasks.replace(() => events.push("second"), () => events.push("cancel-second"));
  const third = tasks.replace(() => events.push("third"), () => events.push("cancel-third"));
  assert.deepEqual(events, ["first", "cancel-second", "cancel-third"]);
  finish();
  await Promise.all([first, second, third]);
  assert.deepEqual(events, ["first", "cancel-second", "cancel-third", "cleanup", "third"]);
});

test("stopping invalidates a queued selection and a rejected preparation does not block another", async () => {
  const tasks = new PlaybackTasks();
  let calls = 0;
  const cancelled = tasks.replace(() => { calls += 1; }, () => {});
  tasks.invalidate();
  await cancelled;
  assert.equal(calls, 0);
  await assert.rejects(tasks.replace(() => { throw new Error("failed"); }, () => {}));
  await tasks.replace(() => { calls += 1; }, () => {});
  assert.equal(calls, 1);
});
