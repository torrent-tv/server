// The life of embedded subtitle delivery across a file switch, a reconnect and
// a page the proxy has not yet answered (torrent-tv/meta#48).
//
// Three defects were found here by review on 2026-08-20, and none had a check:
// a listener stayed registered for every episode opened, a delivery wrote its
// read position after the file it belonged to had been left, and a delivery
// that was ending removed the entry of the one that replaced it. Delivery now
// belongs to `SubtitlePlayback`: one `change` listener for the life of the
// `<video>` element, a one-off seed per track, pushes after it, and a
// re-subscription after a reconnect. These checks hold that shape against the
// browser's own events, with every network answer released by hand.
//
// No browser, no proxy and no torrent: the `<video>`, its track list, the track
// elements and the transport are fakes, and the timers are node's mock timers.

import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { SubtitlePlayback } from "../public/components/loading/SubtitlePlayback.js";

const GLOBALS = ["document", "CustomEvent", "HTMLVideoElement", "VTTCue", "window", "fetch"];

/** `video.textTracks`: an array the code iterates, and the `change` events. */
class TrackList extends Array {
  events = new EventTarget();
  changeListeners = 0;
  addEventListener(type, ...rest) {
    if (type === "change") this.changeListeners += 1;
    this.events.addEventListener(type, ...rest);
  }
  fireChange() { this.events.dispatchEvent(new Event("change")); }
}

class FakeTextTrack {
  mode = "disabled";
  cues = [];
  constructor(element) { this.element = element; }
  get label() { return this.element.label; }
  get language() { return this.element.srclang; }
  addCue(cue) { this.cues.push(cue); }
  removeCue(cue) { this.cues = this.cues.filter((held) => held !== cue); }
}

/**
 * A `<track>` element. Its load is released by the check (`load()`), because
 * the moment between creating a track and its load settling is one of the
 * windows these checks are about.
 */
class FakeTrackElement extends EventTarget {
  label = "";
  srclang = "";
  kind = "";
  src = "";
  loaded = false;
  track = new FakeTextTrack(this);
  load() {
    if (this.loaded || !this.src) return;
    this.loaded = true;
    this.dispatchEvent(new Event("load"));
  }
  remove() {
    this.video.elements = this.video.elements.filter((element) => element !== this);
    const at = this.video.textTracks.indexOf(this.track);
    if (at >= 0) this.video.textTracks.splice(at, 1);
  }
}

class FakeVideo {
  textTracks = new TrackList();
  elements = [];
  currentTime = 0;
  appendChild(element) {
    element.video = this;
    this.elements.push(element);
    this.textTracks.push(element.track);
  }
  querySelectorAll() { return [...this.elements]; }
  loadTracks() { for (const element of this.elements) element.load(); }
}

/**
 * A transport whose every answer is given by the check, in the order it
 * chooses. With `honoursAbort` off, an answer already on its way when the page
 * cancels still arrives — the case the page's own epoch check exists for.
 */
function fakeTransport({ honoursAbort = true } = {}) {
  const requests = [];
  return {
    requests,
    fetch(url, options = {}) {
      return new Promise((resolve, reject) => {
        const request = { url, options, resolve, settled: false };
        if (honoursAbort) {
          options.signal?.addEventListener("abort", () => {
            if (!request.settled) reject(options.signal.reason);
          });
        }
        requests.push(request);
      });
    },
    /** The cue requests for one file, in the order they were made. */
    seeds(fileIndex) {
      return requests.filter((request) => request.url.startsWith("/api/subtitles?") &&
        request.url.includes(`&fileIndex=${fileIndex}&trackIndex=`));
    },
    selections() {
      return requests.filter((request) => request.options.method === "POST").map((request) => JSON.parse(request.options.body));
    }
  };
}

function answer(request, { status = 200, body = "", headers = {} } = {}) {
  request.settled = true;
  request.resolve(new Response(status === 202 ? null : body, { status, headers }));
}

function vtt(...lines) {
  return `WEBVTT\n\n${lines.map((text, at) => `00:00:0${at}.000 --> 00:00:0${at}.900\n${text}\n`).join("\n")}`;
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

/** One embedded text track, as the proxy's plan states it; no container default. */
const PLAN = { subtitleTracks: [{ index: 0, textBased: true, language: "eng" }] };

function setUp(t, { honoursAbort = true } = {}) {
  const saved = Object.fromEntries(GLOBALS.map((key) => [key, globalThis[key]]));
  mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  globalThis.HTMLVideoElement = FakeVideo;
  globalThis.document = Object.assign(new EventTarget(), { createElement: () => new FakeTrackElement() });
  globalThis.CustomEvent = class extends Event {
    constructor(type, options) { super(type); this.detail = options?.detail; }
  };
  globalThis.VTTCue = class {
    constructor(startTime, endTime, text) { Object.assign(this, { startTime, endTime, text }); }
  };
  // Read through at call time, so the mocked timers are the ones used.
  globalThis.window = {
    setTimeout: (...args) => setTimeout(...args),
    clearTimeout: (id) => clearTimeout(id),
    setInterval: (...args) => setInterval(...args),
    clearInterval: (id) => clearInterval(id)
  };
  // Provider discovery is not part of this; it is not asked for a file with no
  // media information, and nothing here announces any.
  globalThis.fetch = () => assert.fail("provider discovery must not run in these checks");

  const video = new FakeVideo();
  const transport = fakeTransport({ honoursAbort });
  const pageSignal = new AbortController().signal;
  const playback = new SubtitlePlayback({
    getVideoElement: () => video,
    getTransport: () => transport,
    getFiles: () => [{ name: "e1.mkv" }, { name: "e2.mkv" }],
    registerSourceOnProxy: async () => "source-key",
    getAbortSignal: () => pageSignal,
    getConsumerId: () => "viewer-1",
    logEvent: () => {}
  });
  playback.setPlan(PLAN);
  // One hook, in this order: the component is cleared while the fakes it
  // reaches for still stand, and only then are the globals given back.
  t.after(() => {
    playback.clear();
    Object.assign(globalThis, saved);
    mock.timers.reset();
  });

  /** Open a file, let its track elements load, and let the first seed go out. */
  async function open(fileIndex) {
    await playback.loadForVideo(fileIndex);
    video.loadTracks();
    await settle();
  }
  const currentTrack = () => video.textTracks[0];
  return { video, transport, playback, open, currentTrack };
}

test("one change listener serves every episode, and it reports the episode open now", async (t) => {
  const { video, transport, open, currentTrack } = setUp(t);
  await open(0);
  await open(1);
  await open(0);
  await open(1);
  assert.equal(video.textTracks.changeListeners, 1, "a listener per file accumulates and answers for the file it was made for");

  // The viewer switches the track on: the choice is reported for the file that
  // is open, never for the one the listener was created under.
  currentTrack().mode = "showing";
  video.textTracks.fireChange();
  await settle();
  const reported = transport.selections().at(-1);
  assert.equal(reported.fileIndex, 1);
  assert.equal(reported.trackIndex, 0);
  assert.equal(reported.off, false);
});

test("a seed answered after its file was left writes neither cues nor its read position into the next file", async (t) => {
  const { transport, playback, open, currentTrack } = setUp(t, { honoursAbort: false });
  await open(0);
  const [leftBehind] = transport.seeds(0);
  assert.ok(leftBehind, "opening a file asks for the cues the proxy has already read");

  await open(1);
  const [current] = transport.seeds(1);
  // The answer for the file that was left arrives first, with a cursor far
  // ahead of anything the new file has been told.
  answer(leftBehind, { body: vtt("from the episode left behind"), headers: { "x-subtitle-cursor": "7" } });
  await settle();
  assert.deepEqual(currentTrack().cues, [], "cues of the file that was left landed in the one open now");

  answer(current, { body: vtt("this episode"), headers: { "x-subtitle-cursor": "2" } });
  await settle();
  assert.deepEqual(currentTrack().cues.map((cue) => cue.text), ["this episode"]);

  // After a reconnect the page asks from where IT left off. A cursor written
  // by the stale seed would ask from 7 and lose cues 3-7 of this episode.
  playback.onTransportReconnected();
  await settle();
  const resubscribed = transport.seeds(1).at(-1);
  assert.notEqual(resubscribed, current);
  assert.match(resubscribed.url, /&since=2$/);
});

test("a seed still waiting for the proxy stops at its next step once its file is left", async (t) => {
  const { transport, open } = setUp(t);
  await open(0);
  // An older proxy that has not read the track yet and does not push: the seed
  // asks again after its poll interval.
  answer(transport.seeds(0)[0], { status: 202 });
  await settle();
  mock.timers.tick(5_000);
  await settle();
  assert.equal(transport.seeds(0).length, 2, "a seed waiting on a proxy that does not push asks again");
  answer(transport.seeds(0)[1], { status: 202 });
  await settle();

  await open(1);
  const asksForNext = transport.seeds(1).length;
  mock.timers.tick(5_000);
  await settle();
  assert.equal(transport.seeds(0).length, 2, "the seed of a file that was left asked the proxy again");
  assert.equal(transport.seeds(1).length, asksForNext, "the stale seed's step disturbed the open file's own seed");
});

test("a proxy that pushes ends the seed: nothing is asked again", async (t) => {
  const { transport, open } = setUp(t);
  await open(0);
  answer(transport.seeds(0)[0], { status: 202, headers: { "x-subtitle-delivery": "push" } });
  await settle();
  mock.timers.tick(60_000);
  await settle();
  assert.equal(transport.seeds(0).length, 1);
});

test("cues pushed while a track is still loading are held, then added once it has loaded", async (t) => {
  const { video, playback, currentTrack } = setUp(t);
  await playback.loadForVideo(0);
  // The track element exists and has not finished its own load: cues put into
  // it now would be emptied by that load.
  playback.onCues({ fileIndex: 0, trackIndex: 0, cursor: 1, cues: [{ id: 1, startSeconds: 1, endSeconds: 2, text: "held" }] });
  assert.deepEqual(currentTrack().cues, []);

  video.loadTracks();
  await settle();
  assert.deepEqual(currentTrack().cues.map((cue) => cue.text), ["held"]);
});

test("a push for a file that was left is dropped, and so is a push held for it", async (t) => {
  const { video, playback, open, currentTrack } = setUp(t);
  await playback.loadForVideo(0);
  playback.onCues({ fileIndex: 0, trackIndex: 0, cursor: 1, cues: [{ id: 1, startSeconds: 1, endSeconds: 2, text: "held for the old file" }] });
  // The file is left before its track has loaded.
  await open(1);
  video.loadTracks();
  await settle();
  playback.onCues({ fileIndex: 0, trackIndex: 0, cursor: 2, cues: [{ id: 2, startSeconds: 3, endSeconds: 4, text: "late push" }] });
  assert.deepEqual(currentTrack().cues, []);

  playback.onCues({ fileIndex: 1, trackIndex: 0, cursor: 1, cues: [{ id: 1, startSeconds: 5, endSeconds: 6, text: "this episode" }] });
  assert.deepEqual(currentTrack().cues.map((cue) => cue.text), ["this episode"]);
});

test("reconnects close together ask once; the next reconnect asks from the newest cursor", async (t) => {
  const { transport, playback, open } = setUp(t);
  await open(0);
  answer(transport.seeds(0)[0], { body: vtt("first"), headers: { "x-subtitle-cursor": "3" } });
  await settle();
  playback.onCues({ fileIndex: 0, trackIndex: 0, cursor: 5, cues: [{ id: 5, startSeconds: 4, endSeconds: 5, text: "pushed" }] });

  playback.onTransportReconnected();
  playback.onTransportReconnected();
  await settle();
  assert.equal(transport.seeds(0).length, 2, "two reconnects in a row asked twice from the same cursor");
  assert.match(transport.seeds(0)[1].url, /&since=5$/);

  answer(transport.seeds(0)[1], { body: vtt("first", "missed while away"), headers: { "x-subtitle-cursor": "6" } });
  await settle();
  playback.onTransportReconnected();
  await settle();
  assert.equal(transport.seeds(0).length, 3);
  assert.match(transport.seeds(0)[2].url, /&since=6$/);
});

test("leaving a file cancels its seed request, and the cancellation is not reported as a failure", async (t) => {
  const { transport, open } = setUp(t);
  const warnings = [];
  const warn = console.warn;
  console.warn = (...args) => warnings.push(args.join(" "));
  t.after(() => { console.warn = warn; });
  await open(0);
  const [request] = transport.seeds(0);
  await open(1);
  assert.equal(request.options.signal.aborted, true);
  await settle();
  assert.deepEqual(warnings.filter((line) => line.includes("seed")), []);
});
