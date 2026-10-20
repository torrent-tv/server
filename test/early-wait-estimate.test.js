import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../public/components/loading/loading.js", import.meta.url), "utf8");
const start = source.indexOf("  async #requestEarlyWaitEstimate(");
assert.ok(start >= 0, "early estimate request method exists");
const end = source.indexOf("\n  }", start) + 4;
const requestMethod = source.slice(start, end);
const elapsedStart = source.indexOf("  #addWaitElapsed(query) {");
const elapsedEnd = source.indexOf("\n  }", elapsedStart) + 4;
const elapsedMethod = source.slice(elapsedStart, elapsedEnd);

function loading(document) {
  const create = new Function("document", "CustomEvent", "PROXY_EVENTS", "getEarlyLinkEstimate", `return class {
    #session = { consumerId: "viewer", viewGeneration: 3, abortController: new AbortController() };
    #activeSourceKey = "source";
    #currentPlaybackWaitStartedAt = null;
    #pendingOriginalWaitStartedAt = null;
    #isAbortError(error) { return error?.name === "AbortError"; }
    ${requestMethod}
    ${elapsedMethod}
    request(transport, sourceKey, file) { return this.#requestEarlyWaitEstimate(transport, sourceKey, file); }
    setWaitStartedAt(value) { this.#pendingOriginalWaitStartedAt = value; }
    changeGeneration(value) { this.#session.viewGeneration = value; }
    changeSource(value) { this.#activeSourceKey = value; }
  }`);
  return new (create(document, CustomEvent, { MEASURED: "proxy-measured" },
    () => ({ linkMbps: 24, linkSampleAgeMs: 130 })))();
}

test("requests a first-frame estimate from the source before proxy metadata is ready", async () => {
  const events = [];
  let request;
  const waitEstimate = {
    version: 1, waitId: "source:0:3", revision: 0, remainingSeconds: 12, ageMs: 0
  };
  const component = loading({ dispatchEvent: event => events.push(event) });
  await component.request({
    fetch: async (url, options) => {
      request = { url, options };
      return { ok: true, json: async () => ({ pending: true, waitEstimate }) };
    }
  }, "source", { index: 0, name: "Film.mkv", length: 800 });

  const url = new URL(request.url, "http://proxy.invalid");
  assert.equal(url.pathname, "/api/sources/source/stats");
  assert.deepEqual(Object.fromEntries(url.searchParams), {
    fileIndex: "0", consumer: "viewer", generation: "3", fileName: "Film.mkv", fileLength: "800",
    linkMbps: "24", linkSampleAgeMs: "130"
  });
  assert.equal(request.options.timeoutMs, 1000);
  assert.equal(events.length, 1);
  assert.deepEqual(events[0].detail.downloadStats.waitEstimate, waitEstimate);
});

test("sends the monotonic age of the original wait with early source requests", async () => {
  let request;
  const events = [];
  const waitEstimate = { version: 1, waitId: "source:0:3", revision: 0, remainingSeconds: 7.75, ageMs: 0 };
  const component = loading({ dispatchEvent: event => events.push(event) });
  component.setWaitStartedAt(performance.now() - 4_250);
  await component.request({ fetch: async url => {
    request = new URL(url, "http://proxy.invalid");
    await new Promise(resolve => setTimeout(resolve, 15));
    return { ok: true, json: async () => ({ pending: true, waitEstimate }) };
  } }, "source", { index: 0, name: "Film.mkv", length: 800 });

  const elapsedMs = Number(request.searchParams.get("waitElapsedMs"));
  assert.ok(elapsedMs >= 4_250 && elapsedMs < 4_300, `unexpected action age ${elapsedMs}`);
  const emittedEstimate = events[0]?.detail.downloadStats.waitEstimate;
  assert.equal(emittedEstimate.remainingSeconds, 7.75);
  assert.ok(emittedEstimate.ageMs >= 10 && emittedEstimate.ageMs < 100);
});

test("a single-file torrent starts the estimate request before waiting for the proxy file list", () => {
  const registration = source.indexOf("this.#session.registerSourceOnProxy(transport)", source.indexOf("async #processPlayback("));
  const estimate = source.indexOf("void this.#requestEarlyWaitEstimate(transport, sourceKey, earlyFile);", registration);
  const fileList = source.indexOf("this.#askWhatIsInTheTorrent(transport, sourceKey", registration);

  assert.ok(registration >= 0);
  assert.ok(estimate > registration && estimate < fileList);
  assert.match(source.slice(registration, fileList), /parsed\.files\.length === 1/);
});

test("metadata source polls keep sending the original action age", () => {
  const start = source.indexOf("  #startTorrentStatsPoll(transport, sourceKey, fileIndex) {");
  const end = source.indexOf("\n  }", start) + 4;
  assert.ok(start >= 0);
  assert.match(source.slice(start, end), /this\.#addWaitElapsed\(query\)/);
});

test("returning to the picker keeps the established proxy transport for the next estimate", () => {
  const resetStart = source.indexOf("  #onAppReset = () => {");
  const resetEnd = source.indexOf("\n  };", resetStart) + 5;
  const stopStart = source.indexOf("  #stopPlayback(options = {}) {");
  const stopEnd = source.indexOf("\n  };", stopStart) + 5;
  assert.ok(resetStart >= 0 && stopStart >= 0);
  assert.match(source.slice(resetStart, resetEnd), /#stopPlayback\(\{ keepTransport: true \}\)/);
  assert.match(source.slice(stopStart, stopEnd), /if \(this\.#proxy && options\.keepTransport !== true\)/);
});

test("a late source estimate from an earlier viewing is ignored", async () => {
  const events = [];
  let answer;
  const component = loading({ dispatchEvent: event => events.push(event) });
  const pending = component.request({ fetch: () => new Promise(resolve => { answer = resolve; }) }, "source",
    { index: 0, name: "Film.mkv", length: 800 });
  component.changeGeneration(4);
  answer({ ok: true, json: async () => ({ pending: true, waitEstimate: {
    version: 1, waitId: "source:0:3", revision: 0, remainingSeconds: 12, ageMs: 0
  } }) });
  await pending;

  assert.equal(events.length, 0);
});

test("a late estimate from a source that was replaced is ignored", async () => {
  const events = [];
  let answer;
  const component = loading({ dispatchEvent: event => events.push(event) });
  const pending = component.request({ fetch: () => new Promise(resolve => { answer = resolve; }) }, "source",
    { index: 0, name: "Film.mkv", length: 800 });
  component.changeSource("new-source");
  answer({ ok: true, json: async () => ({ pending: true, waitEstimate: {
    version: 1, waitId: "source:0:3", revision: 0, remainingSeconds: 12, ageMs: 0
  } }) });
  await pending;

  assert.equal(events.length, 0);
});
