import assert from "node:assert/strict";
import { test } from "node:test";
import { WaitTrace, waitTrace, observeVideoWait } from "../public/domain/wait-trace.js";

test("a proxy retry retains the action origin and identifies each attempt", async () => {
  let now = 100;
  const events = [];
  const trace = new WaitTrace({ enabled: true, now: () => now, id: () => "action-1", emit: event => events.push(event) });
  trace.begin("torrent-file", 50);
  trace.attempt(0, 100, true);
  const request = trace.request("/api/playback-plan", "POST");
  now = 800;
  trace.attempt(0, 800, false);
  request.end({ outcome: "cancelled" });
  now = 1000;
  trace.finish("playing");
  assert.equal(events.at(-1).elapsed, 950);
  assert.deepEqual(events.filter(event => event.event === "attempt").map(event => event.attempt), [1, 2]);
  assert.equal(events.find(event => event.event === "end").attempt, 1);
  assert.equal(request.headers["x-ttv-wait-operation"], "b1");
});

test("a file choice excludes the earlier time spent choosing", () => {
  let now = 100;
  const events = [];
  let id = 0;
  const trace = new WaitTrace({ enabled: true, now: () => now, id: () => String(++id), emit: event => events.push(event) });
  trace.begin("torrent-file", 100);
  now = 5000;
  trace.attempt(2, 5000, false);
  now = 5500;
  trace.finish("playing");
  assert.equal(events.at(-1).elapsed, 500);
  assert.equal(events.at(-1).wait, "2");
});

test("parallel work is recorded separately and errors retain the original error", async () => {
  let now = 0;
  const events = [];
  const trace = new WaitTrace({ enabled: true, now: () => now, id: () => "a", emit: event => events.push(event) });
  trace.begin("file");
  let release;
  const first = trace.run("video", () => new Promise(resolve => { release = resolve; }));
  now = 5000;
  assert.equal(trace.run("audio", () => "copied"), "copied");
  now = 8000;
  release();
  await first;
  assert.deepEqual(events.filter(event => event.event === "end").map(event => event.duration), [0, 8000]);
  const error = new Error("failed");
  await assert.rejects(trace.run("failed", () => Promise.reject(error)), actual => actual === error);
  assert.equal(events.at(-1).outcome, "error");
});

test("disabled observation returns the original promise without extra settlement", () => {
  const trace = new WaitTrace({ emit: () => assert.fail("disabled trace emitted") });
  const promise = Promise.resolve(1);
  assert.equal(trace.run("work", () => promise), promise);
});

test("a frame without audio does not end observation; both advancing frames must have audio", () => {
  const saved = { ...waitTrace };
  const events = [];
  let now = 0;
  let callback;
  let audioBuffered = false;
  Object.assign(waitTrace, { enabled: true, now: () => now, id: () => "action", emit: event => events.push(event) });
  const video = Object.assign(new EventTarget(), { paused: false, currentTime: 0, readyState: 4,
    webkitAudioDecodedByteCount: 100, requestVideoFrameCallback: fn => { callback = fn; return 1; }, cancelVideoFrameCallback() {} });
  try {
    waitTrace.begin("file");
    waitTrace.attempt(0, 0, true);
    observeVideoWait(video, () => ({ audioRequired: true, audioBuffered }));
    video.dispatchEvent(new Event("playing"));
    const frame = () => { now += 40; callback(now, { mediaTime: now / 1000, presentedFrames: now / 40 }); };
    frame();
    frame();
    assert.ok(waitTrace.current);
    audioBuffered = true;
    frame();
    assert.ok(waitTrace.current);
    frame();
    assert.equal(waitTrace.current, null);
    assert.equal(events.at(-1).firstAdvancingFrameAt, 120);
    assert.equal(events.at(-1).confirmedAt, 160);
  } finally { Object.assign(waitTrace, saved); }
});
