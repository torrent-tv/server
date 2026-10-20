import test from "node:test";
import assert from "node:assert/strict";
import { ChapterMetadata } from "../public/domain/chapter-metadata.js";

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}
const response = (fileIndex, revision = 1) => ({ ok: true, status: 200,
  json: async () => ({ version: 1, capability: "supported", state: "available", sourceKey: "source", fileIndex, generation: "first", revision }) });

test("deferred discovery waits until playback starts and activates only once", async () => {
  let calls = 0;
  const metadata = new ChapterMetadata(() => {});
  metadata.select({ sourceKey: "source", fileIndex: 0, defer: true,
    transport: { fetch: async () => { calls++; return response(0); } } });
  await metadata.refresh();
  assert.equal(calls, 0);
  metadata.activate(); await metadata.reading;
  metadata.activate();
  assert.equal(calls, 1);
});

test("late chapter response cannot replace the newly selected file", async () => {
  const first = deferred(), second = deferred(), published = [];
  const transport = { fetch: (url) => url.endsWith("=0") ? first.promise : second.promise };
  const metadata = new ChapterMetadata((value) => published.push(value));
  metadata.select({ sourceKey: "source", fileIndex: 0, transport });
  const oldRead = metadata.reading;
  metadata.select({ sourceKey: "source", fileIndex: 1, transport });
  second.resolve(response(1)); await metadata.reading;
  first.resolve(response(0)); await oldRead;
  assert.equal(metadata.snapshot.fileIndex, 1);
  assert.deepEqual(published.filter(Boolean).map((value) => value.fileIndex), [1]);
});

test("clearing selection aborts the request and ignores its response", async () => {
  const pending = deferred(); let signal;
  const metadata = new ChapterMetadata(() => {});
  metadata.select({ sourceKey: "source", fileIndex: 0, transport: { fetch: (_, options) => { signal = options.signal; return pending.promise; } } });
  const reading = metadata.reading;
  metadata.clear();
  assert.equal(signal.aborted, true);
  pending.resolve(response(0)); await reading;
  assert.equal(metadata.snapshot, null);
});

test("an old proxy gives an explicit unsupported endpoint result", async () => {
  const metadata = new ChapterMetadata(() => {});
  metadata.select({ sourceKey: "source", fileIndex: 0, transport: { fetch: async () => ({ status: 404 }) } });
  await metadata.reading;
  assert.equal(metadata.snapshot.state, "unsupported");
  assert.equal(metadata.snapshot.reason, "chapter-endpoint-unavailable");
  assert.equal(metadata.snapshot.capability, "unsupported");
});

test("a missing source remains an error instead of proving the proxy lacks chapter support", async () => {
  const metadata = new ChapterMetadata(() => {});
  metadata.select({ sourceKey: "source", fileIndex: 0, transport: { fetch: async () => ({ status: 404,
    json: async () => ({ code: "SOURCE_NOT_FOUND", error: "Source key was not found." }) }) } });
  await metadata.reading;
  assert.equal(metadata.snapshot.state, "error");
  assert.equal(metadata.snapshot.reason, "source-not-found");
  assert.equal(metadata.snapshot.capability, "supported");
});

test("notification during a request triggers one additional read", async () => {
  const pending = deferred(); let calls = 0;
  const metadata = new ChapterMetadata(() => {});
  metadata.select({ sourceKey: "source", fileIndex: 0, transport: { fetch: () => ++calls === 1 ? pending.promise : Promise.resolve(response(0, 2)) } });
  const initial = metadata.reading;
  metadata.changed({ sourceKey: "source", fileIndex: 0 });
  metadata.changed({ sourceKey: "other", fileIndex: 0 });
  pending.resolve(response(0)); await initial;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 2);
  assert.equal(metadata.snapshot.revision, 2);
});

test("older revisions cannot overwrite an available result", async () => {
  let revision = 2;
  const metadata = new ChapterMetadata(() => {});
  metadata.select({ sourceKey: "source", fileIndex: 0, transport: { fetch: async () => response(0, revision) } });
  await metadata.reading;
  revision = 1; await metadata.refresh();
  assert.equal(metadata.snapshot.revision, 2);
});

test("a new cache generation accepts its lower revision after expiry or proxy replacement", async () => {
  let generation = "first", revision = 9;
  const metadata = new ChapterMetadata(() => {});
  metadata.select({ sourceKey: "source", fileIndex: 0, transport: { fetch: async () => ({ ok: true, status: 200,
    json: async () => ({ version: 1, capability: "supported", state: "available", sourceKey: "source", fileIndex: 0, generation, revision }) }) } });
  await metadata.reading;
  generation = "second"; revision = 1;
  await metadata.refresh();
  assert.equal(metadata.snapshot.generation, "second");
  assert.equal(metadata.snapshot.revision, 1);
});

test("a transport error remains recoverable", async () => {
  let failed = true;
  const metadata = new ChapterMetadata(() => {});
  metadata.select({ sourceKey: "source", fileIndex: 0, transport: { fetch: async () => {
    if (failed) throw new Error("Disconnected");
    return response(0);
  } } });
  await metadata.reading;
  assert.equal(metadata.snapshot.state, "error");
  assert.equal(metadata.snapshot.complete, false);
  failed = false; await metadata.refresh();
  assert.equal(metadata.snapshot.state, "available");
});

test("a request that never receives a response becomes a recoverable error", async () => {
  let requestSignal;
  const metadata = new ChapterMetadata(() => {}, { requestTimeoutMs: 10 });
  metadata.select({ sourceKey: "source", fileIndex: 0, transport: { fetch: (_, options) => {
    requestSignal = options.signal;
    return new Promise((_, reject) => options.signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true }));
  } } });
  await metadata.reading;
  assert.equal(requestSignal.aborted, true);
  assert.equal(metadata.snapshot.state, "error");
  assert.equal(metadata.snapshot.complete, false);
});

