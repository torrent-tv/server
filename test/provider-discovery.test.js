import assert from "node:assert/strict";
import test from "node:test";
import { ProviderSubtitles } from "../public/components/loading/ProviderSubtitles.js";
import { MEDIA_INFO_EVENTS } from "../public/shared/events.js";

test("late discovery is discarded after a file switch and discovery never downloads files", async () => {
  const originals = { document: globalThis.document, CustomEvent: globalThis.CustomEvent, fetch: globalThis.fetch };
  globalThis.document = new EventTarget();
  globalThis.CustomEvent = class extends Event { constructor(type, options) { super(type); this.detail = options.detail; } };
  const requests = [];
  globalThis.fetch = (path, options) => new Promise(resolve => requests.push({ path, options, resolve }));
  try {
    const answers = [];
    const controller = new ProviderSubtitles(items => answers.push(items));
    document.dispatchEvent(new CustomEvent(MEDIA_INFO_EVENTS.CHANGED, { detail: {
      pictures: { 0: { normalized: { kind: "movie" }, sources: { tmdb: { tmdbId: 1 } } }, 1: { normalized: { kind: "movie" }, sources: { tmdb: { tmdbId: 2 } } } }
    } }));
    controller.start(0);
    controller.start(1);
    assert.equal(requests.length, 2);
    assert.ok(requests[0].options.signal.aborted);
    requests[1].resolve(new Response(JSON.stringify({ providers: [{ items: [{ id: "new" }] }] })));
    await new Promise(resolve => setImmediate(resolve));
    requests[0].resolve(new Response(JSON.stringify({ providers: [{ items: [{ id: "old" }] }] })));
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(answers, [[{ id: "new" }]]);
    assert.ok(requests.every(request => request.path === "/api/subtitles/search"));
    controller.clear();
  } finally { Object.assign(globalThis, originals); }
});

test("a stale download permit refreshes the same file once without downloading another variant", async () => {
  const originals = { document: globalThis.document, CustomEvent: globalThis.CustomEvent, fetch: globalThis.fetch };
  globalThis.document = new EventTarget();
  globalThis.CustomEvent = class extends Event { constructor(type, options) { super(type); this.detail = options.detail; } };
  const paths = [];
  let files = 0;
  globalThis.fetch = async (path, options) => {
    paths.push(path);
    if (path.endsWith("/search")) return new Response(JSON.stringify({ providers: [{ items: [{ provider: "fake", id: "1", token: "fresh" }] }] }));
    files++;
    if (files === 1) return new Response("expired", { status: 410 });
    assert.equal(JSON.parse(options.body).token, "fresh");
    return new Response("WEBVTT\n\n");
  };
  try {
    const controller = new ProviderSubtitles(() => {});
    document.dispatchEvent(new CustomEvent(MEDIA_INFO_EVENTS.CHANGED, { detail: { work: { normalized: { kind: "movie" }, sources: { tmdb: { tmdbId: 1 } } } } }));
    controller.start(0);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(await controller.load({ provider: "fake", id: "1", token: "old" }, new AbortController().signal), "WEBVTT\n\n");
    assert.deepEqual(paths, ["/api/subtitles/search", "/api/subtitles/file", "/api/subtitles/search", "/api/subtitles/file"]);
    controller.clear();
  } finally { Object.assign(globalThis, originals); }
});

test("metadata that withdraws a work match cancels its pending subtitle discovery", async () => {
  const originals = { document: globalThis.document, CustomEvent: globalThis.CustomEvent, fetch: globalThis.fetch };
  globalThis.document = new EventTarget();
  globalThis.CustomEvent = class extends Event { constructor(type, options) { super(type); this.detail = options.detail; } };
  let request;
  globalThis.fetch = (_path, options) => new Promise(resolve => { request = { options, resolve }; });
  try {
    const answers = [];
    const controller = new ProviderSubtitles(items => answers.push(items));
    document.dispatchEvent(new CustomEvent(MEDIA_INFO_EVENTS.CHANGED, { detail: { work: { normalized: { kind: "movie", tmdbId: 1 } } } }));
    controller.start(0);
    document.dispatchEvent(new CustomEvent(MEDIA_INFO_EVENTS.CHANGED, { detail: { work: null } }));
    assert.ok(request.options.signal.aborted);
    request.resolve(new Response(JSON.stringify({ providers: [{ items: [{ id: "old" }] }] })));
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(answers, [[]]);
    controller.clear();
  } finally { Object.assign(globalThis, originals); }
});
