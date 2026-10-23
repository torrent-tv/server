import assert from "node:assert/strict";
import { test } from "node:test";
import { WaitTrace, waitTrace, observeHlsWait, observeVideoWait } from "../public/domain/wait-trace.js";
import { createWebRtcHlsLoader } from "../public/domain/webrtc-hls-loader.js";

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
  let now = 10;
  Object.assign(waitTrace, { enabled: true, now: () => now, id: () => "action", emit: event => events.push(event),
    current: null, sequence: 0, hlsSequence: 0, hlsObservers: new Map() });
  const hls = { on: (name, handler) => listeners.set(name, handler) };
  const fire = (name, data = {}) => listeners.get(name)?.(name, data);
  try {
    waitTrace.begin("torrent-file");
    waitTrace.attempt(0, 10, true);
    const Events = Object.fromEntries(["MANIFEST_LOADING", "MANIFEST_LOADED", "MANIFEST_PARSED", "LEVEL_LOADING", "LEVEL_LOADED",
      "AUDIO_TRACK_LOADING", "AUDIO_TRACK_LOADED", "FRAG_LOADING",
      "FRAG_LOADED", "FRAG_PARSING_INIT_SEGMENT", "FRAG_PARSED", "BUFFER_CODECS", "BUFFER_CREATED", "BUFFER_APPENDING",
      "BUFFER_APPENDED", "FRAG_BUFFERED", "ERROR"].map(name => [name, name]));
    observeHlsWait(hls, Events);
    fire("MANIFEST_LOADING");
    fire("MANIFEST_LOADED", { stats: { parsing: { start: 7, end: 9 } }, url: "master.m3u8" });
    fire("MANIFEST_PARSED");
    fire("LEVEL_LOADING");
    fire("LEVEL_LOADED");
    fire("AUDIO_TRACK_LOADING");
    fire("AUDIO_TRACK_LOADED");
    fire("FRAG_LOADING", { type: "main", frag: { sn: 0, level: 0 } });
    fire("FRAG_LOADED", { type: "main", frag: { sn: 0, level: 0 }, payload: new Uint8Array(4) });
    fire("FRAG_PARSING_INIT_SEGMENT", { id: "main", frag: { sn: 0 } });
    fire("BUFFER_CODECS", { video: {}, frag: { sn: 0 } });
    assert.equal(events.filter(event => event.event === "end" && event.process === "B8.v").length, 0);
    fire("FRAG_PARSED", { id: "main", frag: { sn: 0 } });
    fire("FRAG_LOADED", { id: "audio", frag: { sn: 0, level: 0 } });
    fire("FRAG_PARSING_INIT_SEGMENT", { id: "audio", frag: { sn: 0 } });
    now = 50;
    fire("BUFFER_CREATED", { tracks: { video: {}, audio: {} } });
    now = 51;
    fire("BUFFER_CODECS", { audio: {}, frag: { sn: 0 } });
    fire("FRAG_PARSED", { id: "audio", frag: { sn: 0 } });
    fire("BUFFER_APPENDING", { type: "video", parent: "main", frag: { sn: "initSegment" } });
    fire("BUFFER_APPENDED", { type: "video", parent: "main", frag: { sn: "initSegment" } });
    fire("BUFFER_APPENDING", { type: "video", parent: "main", frag: { sn: 0 } });
    fire("BUFFER_APPENDED", { type: "video", parent: "main", frag: { sn: 0 } });
    assert.ok(events.some(event => event.event === "begin" && event.process === "B8.v"));
    assert.ok(events.some(event => event.event === "begin" && event.process === "B8.a"));
    assert.ok(events.some(event => event.event === "end" && event.process === "B8.a"));
    assert.ok(events.some(event => event.event === "begin" && event.process === "B5"));
    assert.ok(events.some(event => event.event === "end" && event.process === "B5"));
    assert.ok(events.some(event => event.event === "begin" && event.process === "B9"));
    const sourceBufferSpan = events.find(event => event.event === "end" && event.name === "B9.source-buffers");
    assert.equal(sourceBufferSpan.duration, 40);
    assert.equal(sourceBufferSpan.startedAt, 10);
    assert.ok(events.some(event => event.event === "BUFFER_CREATED" && event.process === "B9"));
    assert.ok(events.some(event => event.event === "begin" && event.process === "B10.v"));
    assert.ok(events.some(event => event.event === "begin" && event.process === "B12.v"));
    assert.equal(events.filter(event => event.event === "end" && ["B8.v", "B10.v", "B12.v"].includes(event.process)).length, 3);
  } finally { Object.assign(waitTrace, saved); }
});

test("manifest parse spans use hls.js measured parser boundaries", () => {
  const saved = { ...waitTrace };
  const events = [];
  let now = 0;
  Object.assign(waitTrace, { enabled: true, now: () => now, id: () => "action", emit: event => events.push(event),
    current: null, sequence: 0, hlsSequence: 0, manifestParseEnds: new Map(), hlsObservers: new Map() });
  const createHls = () => {
    const listeners = new Map();
    return { on: (name, handler) => listeners.set(name, handler), fire: (name, data) => listeners.get(name)?.(name, data) };
  };
  try {
    waitTrace.begin("torrent-file");
    waitTrace.attempt(0, 0, true);
    const Events = { MANIFEST_LOADED: "MANIFEST_LOADED", MANIFEST_PARSED: "MANIFEST_PARSED" };
    const first = createHls();
    const second = createHls();
    observeHlsWait(first, Events);
    observeHlsWait(second, Events);
    now = 10;
    first.fire("MANIFEST_LOADED", { url: "first.m3u8", stats: { parsing: { start: 4, end: 8 } } });
    now = 20;
    second.fire("MANIFEST_LOADED", { url: "second.m3u8", stats: { parsing: { start: 12, end: 19 } } });
    now = 25;
    second.fire("MANIFEST_PARSED");
    now = 40;
    first.fire("MANIFEST_PARSED");

    const spans = events.filter(event => event.event === "end" && event.name === "B5.manifest-parse");
    assert.deepEqual(spans.map(({ duration, hlsInstance, startedAt, endedAt }) =>
      [duration, hlsInstance, startedAt, endedAt]), [[4, "hls-1", 4, 8], [7, "hls-2", 12, 19]]);
  } finally { Object.assign(waitTrace, saved); }
});

test("unfinished HLS spans close at wait end and cannot close during a later seek", () => {
  const saved = { ...waitTrace };
  const events = [];
  let now = 0;
  const listeners = new Map();
  Object.assign(waitTrace, { enabled: true, now: () => now, id: () => "action", emit: event => events.push(event),
    current: null, sequence: 0, hlsSequence: 0, manifestParseEnds: new Map(), hlsObservers: new Map() });
  const hls = { on: (name, handler) => listeners.set(name, handler) };
  const fire = (name, data = {}) => listeners.get(name)?.(name, data);
  try {
    waitTrace.begin("torrent-file");
    waitTrace.attempt(0, 0, true);
    observeHlsWait(hls, { FRAG_LOADED: "FRAG_LOADED", FRAG_PARSING_INIT_SEGMENT: "FRAG_PARSING_INIT_SEGMENT", FRAG_PARSED: "FRAG_PARSED" });
    now = 10;
    fire("FRAG_LOADED", { id: "main", frag: { sn: 0 } });
    waitTrace.finish("advancing-with-decoded-audio");
    const endedAtWait = events.find(event => event.event === "end" && event.process === "B8.v");
    assert.equal(endedAtWait.outcome, "active-at-wait-end");

    waitTrace.begin("seek");
    waitTrace.attempt(0, now, true);
    now = 15;
    fire("FRAG_LOADED", { id: "main", frag: { sn: 1 } });
    now = 20;
    waitTrace.attempt(0, now, false);
    const endedAtRetry = events.filter(event => event.event === "end" && event.process === "B8.v").at(-1);
    assert.equal(endedAtRetry.outcome, "cancelled");
    assert.equal(endedAtRetry.reason, "attempt-changed");
    fire("FRAG_PARSED", { id: "main", frag: { sn: 1 } });
    assert.equal(events.filter(event => event.event === "end" && event.process === "B8.v").length, 2);
  } finally { Object.assign(waitTrace, saved); }
});

test("HLS request spans include the full response body and identify the media process", async () => {
  const saved = { ...waitTrace };
  const events = [];
  Object.assign(waitTrace, { enabled: true, now: () => 10, id: () => "action", emit: event => events.push(event),
    current: null, sequence: 0, hlsSequence: 0, hlsObservers: new Map() });
  try {
    waitTrace.begin("torrent-file");
    waitTrace.attempt(0, 10, true);
    const Loader = createWebRtcHlsLoader({ fetch: async () => ({ ok: true, status: 200,
      arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer, text: async () => "#EXTM3U" }) });
    const requests = [
      { url: "http://webrtc-proxy/transcode/1/master.m3u8?variant=1", type: "manifest", responseType: "text", process: "B5" },
      { url: "http://webrtc-proxy/transcode/1/level.m3u8?level=2", type: "level", responseType: "text", process: "B5" },
      { url: "http://webrtc-proxy/transcode/1/audio.m3u8?track=1", type: "audioTrack", responseType: "text", process: "B6.a.p" },
      { url: "http://webrtc-proxy/transcode/1/init.mp4", type: "media-fragment", responseType: "arraybuffer",
        frag: { sn: "initSegment", type: "audio" }, process: "B6.a.i" },
      { url: "http://webrtc-proxy/transcode/1/seg.m4s?consumer=x", type: "media-fragment", responseType: "arraybuffer",
        frag: { sn: 0, type: "audio" }, process: "B7.a" },
      { url: "http://webrtc-proxy/transcode/1/seg.m4s", type: "media-fragment", responseType: "arraybuffer",
        frag: { sn: 0, type: "main" }, process: "B7.v" }
    ];
    for (const request of requests) {
      const loader = new Loader();
      await new Promise((resolve, reject) => loader.load(request, {}, { onSuccess: resolve, onError: reject }));
      const begin = events.findLast(event => event.event === "begin" && event.process === request.process);
      const end = events.find(event => event.event === "end" && event.operation === begin.operation);
      assert.equal(end.outcome, "body-complete");
      assert.equal(end.bytes, request.responseType === "text" ? 7 : 3);
    }
  } finally { Object.assign(waitTrace, saved); }
});

test("a fatal HLS error closes pending parse, remux and append spans", () => {
  const saved = { ...waitTrace };
  const events = [];
  const listeners = new Map();
  Object.assign(waitTrace, { enabled: true, now: () => 10, id: () => "action", emit: event => events.push(event),
    current: null, sequence: 0, hlsSequence: 0, hlsObservers: new Map() });
  const hls = { on: (name, handler) => listeners.set(name, handler) };
  const fire = (name, data = {}) => listeners.get(name)?.(name, data);
  try {
    waitTrace.begin("torrent-file");
    waitTrace.attempt(0, 10, true);
    observeHlsWait(hls, Object.fromEntries(["MANIFEST_LOADED", "MANIFEST_PARSED", "FRAG_LOADED", "FRAG_PARSING_INIT_SEGMENT",
      "BUFFER_APPENDING", "ERROR"].map(name => [name, name])));
    fire("MANIFEST_LOADED", { stats: { parsing: { start: 1, end: 2 } } });
    fire("FRAG_LOADED", { type: "main", frag: { sn: 0 } });
    fire("BUFFER_APPENDING", { type: "video", parent: "main", frag: { sn: "initSegment" } });
    fire("ERROR", { fatal: true, details: "manifestLoadError" });
    const failed = events.filter(event => event.event === "end" && event.outcome === "error");
    assert.deepEqual(failed.map(event => event.process).sort(), ["B10.v", "B8.v"]);
  } finally { Object.assign(waitTrace, saved); }
});

test("destroying HLS closes unfinished parse, remux and append spans as cancelled", () => {
  const saved = { ...waitTrace };
  const events = [];
  const listeners = new Map();
  Object.assign(waitTrace, { enabled: true, now: () => 10, id: () => "action", emit: event => events.push(event),
    current: null, sequence: 0, hlsSequence: 0, manifestParseEnds: new Map(), hlsObservers: new Map() });
  const hls = { on: (name, handler) => listeners.set(name, handler) };
  const fire = (name, data = {}) => listeners.get(name)?.(name, data);
  try {
    waitTrace.begin("torrent-file");
    waitTrace.attempt(0, 10, true);
    observeHlsWait(hls, Object.fromEntries(["DESTROYING", "MANIFEST_LOADED", "FRAG_LOADED", "FRAG_PARSING_INIT_SEGMENT",
      "BUFFER_APPENDING"].map(name => [name, name])));
    fire("MANIFEST_LOADED", { stats: { parsing: { start: 1, end: 2 } } });
    fire("FRAG_LOADED", { id: "main", frag: { sn: 0 } });
    fire("BUFFER_APPENDING", { type: "video", parent: "main", frag: { sn: "initSegment" } });
    fire("DESTROYING");
    const cancelled = events.filter(event => event.event === "end" && event.outcome === "cancelled");
    assert.deepEqual(cancelled.map(event => event.process).sort(), ["B10.v", "B8.v"]);
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
    assert.equal(events.at(-1).firstAdvancingFrameElapsedMs, 120);
    assert.equal(events.at(-1).confirmedAt, 160);
  } finally { Object.assign(waitTrace, saved); }
});

test("seek presentation starts at seeking and ignores a frame callback timestamp from before the seek", () => {
  const saved = { ...waitTrace };
  const events = [];
  let now = 100;
  let callback;
  const video = Object.assign(new EventTarget(), { paused: false, currentTime: 24, readyState: 4,
    webkitAudioDecodedByteCount: 100, requestVideoFrameCallback: fn => { callback = fn; return 1; }, cancelVideoFrameCallback() {} });
  Object.assign(waitTrace, { enabled: true, now: () => now, id: () => "seek-action", emit: event => events.push(event),
    current: null, sequence: 0 });
  try {
    video.addEventListener("seeking", () => {
      waitTrace.begin("seek", 100);
      waitTrace.attempt(0, 100, true);
    });
    observeVideoWait(video, () => ({ audioRequired: true, audioBuffered: true }));

    video.dispatchEvent(new Event("seeking"));
    const presentationBegins = events.filter(event => event.name === "C6.presentation" && event.phase === "begin");
    assert.equal(presentationBegins.length, 1);
    assert.equal(presentationBegins[0].at, 100);

    now = 105;
    callback(95, { mediaTime: 23.958, presentedFrames: 1 });
    assert.equal(events.some(event => event.event === "first-frame"), false);

    now = 110;
    video.dispatchEvent(new Event("playing"));
    assert.equal(events.filter(event => event.name === "C6.presentation" && event.phase === "begin").length, 1);
    callback(110, { mediaTime: 24, presentedFrames: 2 });
    now = 150;
    callback(150, { mediaTime: 24.042, presentedFrames: 3 });

    const presentationEnd = events.find(event => event.name === "C6.presentation" && event.phase === "end");
    assert.equal(presentationEnd.duration, 10);
    assert.equal(events.at(-1).firstAdvancingFrameAt, 110);
    assert.equal(events.at(-1).firstAdvancingFrameElapsedMs, 10);
    assert.ok(events.every(event => !Number.isFinite(event.duration) || event.duration >= 0));
  } finally { Object.assign(waitTrace, saved); }
});
