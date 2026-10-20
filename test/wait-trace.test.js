import assert from "node:assert/strict";
import { test } from "node:test";
import { WaitTrace, waitTrace, observeHlsWait, observeVideoWait } from "../public/domain/wait-trace.js";

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
  assert.equal(request.headers["x-ttv-wait-process"], "A12");
  assert.equal(events.find(event => event.event === "begin").process, "A12");
});

test("HLS observations give separate spans to remux, buffer creation, init append and media append", () => {
  const saved = { ...waitTrace };
  const events = [];
  const listeners = new Map();
  Object.assign(waitTrace, { enabled: true, now: () => 10, id: () => "action", emit: event => events.push(event),
    current: null, sequence: 0 });
  const hls = { on: (name, handler) => listeners.set(name, handler) };
  const fire = (name, data = {}) => listeners.get(name)?.(name, data);
  try {
    waitTrace.begin("torrent-file");
    waitTrace.attempt(0, 10, true);
    const Events = Object.fromEntries(["MANIFEST_LOADING", "MANIFEST_LOADED", "MANIFEST_PARSED", "LEVEL_LOADING", "LEVEL_LOADED",
      "AUDIO_TRACK_LOADING", "AUDIO_TRACK_LOADED", "FRAG_LOADING",
      "FRAG_LOADED", "FRAG_PARSING_INIT_SEGMENT", "BUFFER_CODECS", "BUFFER_CREATED", "BUFFER_APPENDING",
      "BUFFER_APPENDED", "FRAG_BUFFERED", "ERROR"].map(name => [name, name]));
    observeHlsWait(hls, Events);
    fire("MANIFEST_LOADING");
    fire("MANIFEST_LOADED");
    fire("MANIFEST_PARSED");
    fire("LEVEL_LOADING");
    fire("LEVEL_LOADED");
    fire("AUDIO_TRACK_LOADING");
    fire("AUDIO_TRACK_LOADED");
    fire("FRAG_LOADING", { type: "main", frag: { sn: 0, level: 0 } });
    fire("FRAG_LOADED", { type: "main", frag: { sn: 0, level: 0 }, payload: new Uint8Array(4) });
    fire("FRAG_PARSING_INIT_SEGMENT", { type: "main", frag: { sn: 0 } });
    fire("BUFFER_CODECS", { type: "main", frag: { sn: 0 } });
    fire("BUFFER_CODECS", { type: "audio", frag: { sn: 0 } });
    fire("BUFFER_CREATED", { tracks: { main: {}, audio: {} } });
    fire("BUFFER_APPENDING", { type: "main", parent: "main", frag: { sn: 0 } });
    fire("BUFFER_APPENDED", { type: "main", parent: "main", frag: { sn: 0 } });
    fire("BUFFER_APPENDING", { type: "main", parent: "main", frag: { sn: 0 } });
    fire("BUFFER_APPENDED", { type: "main", parent: "main", frag: { sn: 0 } });
    assert.ok(events.some(event => event.event === "begin" && event.process === "B8.v"));
    assert.ok(events.some(event => event.event === "begin" && event.process === "B5"));
    assert.ok(events.some(event => event.event === "end" && event.process === "B5"));
    assert.ok(events.some(event => event.event === "begin" && event.name === "B5.level-playlist"));
    assert.ok(events.some(event => event.event === "begin" && event.process === "B6.a.p"));
    assert.ok(events.some(event => event.event === "begin" && event.process === "B7.v"));
    assert.ok(events.some(event => event.event === "end" && event.process === "B7.v"));
    assert.ok(events.some(event => event.event === "begin" && event.process === "B9"));
    assert.ok(events.some(event => event.event === "end" && event.process === "B9"));
    assert.ok(events.some(event => event.event === "BUFFER_CREATED" && event.process === "B9"));
    assert.ok(events.some(event => event.event === "begin" && event.process === "B10.v"));
    assert.ok(events.some(event => event.event === "begin" && event.process === "B12.v"));
    assert.equal(events.filter(event => event.event === "end" && ["B8.v", "B10.v", "B12.v"].includes(event.process)).length, 3);
  } finally { Object.assign(waitTrace, saved); }
});

test("a recoverable HLS error closes only its failed fragment request", () => {
  const saved = { ...waitTrace };
  const events = [];
  const listeners = new Map();
  Object.assign(waitTrace, { enabled: true, now: () => 10, id: () => "action", emit: event => events.push(event),
    current: null, sequence: 0 });
  const hls = { on: (name, handler) => listeners.set(name, handler) };
  const fire = (name, data = {}) => listeners.get(name)?.(name, data);
  try {
    waitTrace.begin("torrent-file");
    waitTrace.attempt(0, 10, true);
    observeHlsWait(hls, Object.fromEntries(["FRAG_LOADING", "FRAG_LOADED", "ERROR"].map(name => [name, name])));
    fire("FRAG_LOADING", { type: "main", frag: { sn: 1, level: 0 } });
    fire("FRAG_LOADING", { type: "audio", frag: { sn: 1, level: 0 } });
    fire("ERROR", { fatal: false, details: "fragLoadError", type: "main", frag: { sn: 1, level: 0 } });
    const failed = events.filter(event => event.event === "end" && event.outcome === "error");
    assert.equal(failed.length, 1);
    assert.equal(failed[0].process, "B7.v");
    assert.ok(events.some(event => event.event === "begin" && event.process === "B7.a"));
  } finally { Object.assign(waitTrace, saved); }
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
