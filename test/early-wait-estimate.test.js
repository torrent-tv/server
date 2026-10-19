import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../public/components/loading/loading.js", import.meta.url), "utf8");
const start = source.indexOf("  async #requestEarlyWaitEstimate(");
assert.ok(start >= 0, "early estimate request method exists");
const end = source.indexOf("\n  }", start) + 4;
const requestMethod = source.slice(start, end);

function loading(document) {
  const create = new Function("document", "CustomEvent", "PROXY_EVENTS", `return class {
    #session = { consumerId: "viewer", viewGeneration: 3, abortController: new AbortController() };
    #activeSourceKey = "source";
    #isAbortError(error) { return error?.name === "AbortError"; }
    ${requestMethod}
    request(transport, sourceKey, file) { return this.#requestEarlyWaitEstimate(transport, sourceKey, file); }
    changeGeneration(value) { this.#session.viewGeneration = value; }
    changeSource(value) { this.#activeSourceKey = value; }
  }`);
  return new (create(document, CustomEvent, { MEASURED: "proxy-measured" }))();
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
    fileIndex: "0", consumer: "viewer", generation: "3", fileName: "Film.mkv", fileLength: "800"
  });
  assert.equal(request.options.timeoutMs, 1000);
  assert.equal(events.length, 1);
  assert.deepEqual(events[0].detail.downloadStats.waitEstimate, waitEstimate);
});

test("a single-file torrent starts the estimate request before waiting for the proxy file list", () => {
  const registration = source.indexOf("const sourceKey = await this.#session.registerSourceOnProxy(transport);");
  const estimate = source.indexOf("void this.#requestEarlyWaitEstimate(transport, sourceKey, earlyFile);", registration);
  const fileList = source.indexOf("const contents = await this.#askWhatIsInTheTorrent(transport, sourceKey", registration);

  assert.ok(registration >= 0);
  assert.ok(estimate > registration && estimate < fileList);
  assert.match(source.slice(registration, fileList), /parsed\.files\.length === 1/);
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
