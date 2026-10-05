import assert from "node:assert/strict";
import test from "node:test";
import { SubtitlePlayback } from "../public/components/loading/SubtitlePlayback.js";
import { MEDIA_INFO_EVENTS, PLAYER_EVENTS } from "../public/shared/events.js";

test("announced provider tracks stay disabled, and a late download cannot undo Off or a file switch", async () => {
  const saved = Object.fromEntries(["document", "CustomEvent", "HTMLVideoElement", "fetch", "window"].map(key => [key, globalThis[key]]));
  class Tracks extends Array {
    events = new EventTarget();
    addEventListener(...args) { this.events.addEventListener(...args); }
  }
  class Video {
    textTracks = new Tracks();
    elements = [];
    currentTime = 0;
    appendChild(element) { element.video = this; this.elements.push(element); this.textTracks.push(element.track); }
    querySelectorAll() { return [...this.elements]; }
  }
  class TrackElement extends EventTarget {
    track = { mode: "disabled", cues: [{ startTime: 0, endTime: 100 }], get label() { return this.element.label; } };
    constructor() { super(); this.track.element = this; }
    set src(_url) { queueMicrotask(() => this.dispatchEvent(new Event("load"))); }
    remove() {
      this.video.elements = this.video.elements.filter(el => el !== this);
      const at = this.video.textTracks.indexOf(this.track);
      if (at >= 0) this.video.textTracks.splice(at, 1);
    }
  }
  globalThis.HTMLVideoElement = Video;
  globalThis.document = Object.assign(new EventTarget(), { createElement: () => new TrackElement() });
  globalThis.CustomEvent = class extends Event { constructor(type, options) { super(type); this.detail = options.detail; } };
  globalThis.window = { setInterval, clearInterval, setTimeout };
  const downloads = [];
  globalThis.fetch = async path => {
    if (path.endsWith("/search")) return new Response(JSON.stringify({ providers: [{ provider: "opensubtitles", status: "complete", items: [{ provider: "opensubtitles", id: "1", language: "en", release: "Film", token: "fake" }] }] }));
    return new Promise(resolve => downloads.push(resolve));
  };
  let playback;
  try {
    const video = new Video();
    let menu;
    document.addEventListener(PLAYER_EVENTS.SET_SUBTITLE_TRACKS, event => { menu = event.detail.items; });
    playback = new SubtitlePlayback({ getVideoElement: () => video, getTransport: () => null, getFiles: () => [], registerSourceOnProxy: () => {}, getAbortSignal: () => new AbortController().signal, getConsumerId: () => "fake", logEvent: () => {} });
    document.dispatchEvent(new CustomEvent(MEDIA_INFO_EVENTS.CHANGED, { detail: { work: { normalized: { kind: "movie" }, sources: { tmdb: { tmdbId: 1 } } } } }));
    await playback.loadForVideo(0);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(downloads.length, 0);
    assert.equal(menu.length, 1);
    assert.equal(video.textTracks[0].mode, "disabled");
    playback.select(menu[0].key);
    playback.select("");
    downloads[0](new Response("WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nHello\n"));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(video.textTracks[0].mode, "disabled");
    playback.select(menu[0].key);
    downloads[1](new Response("WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nHello\n"));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(video.textTracks[0].mode, "showing");
    await playback.loadForVideo(1);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(video.textTracks[0].mode, "disabled");
    playback.select(menu[0].key);
    const pendingResetDownload = downloads.at(-1);
    playback.reset();
    assert.equal(menu.length, 0);
    pendingResetDownload(new Response("WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nLate\n"));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(menu.length, 0);
    assert.equal(video.textTracks.length, 0);
  } finally { playback?.clear(); Object.assign(globalThis, saved); }
});
