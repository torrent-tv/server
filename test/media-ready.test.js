import assert from "node:assert/strict";
import test from "node:test";
import { waitForMediaReady } from "../public/domain/media-ready.js";

function media() {
  return Object.assign(new EventTarget(), { readyState: 0, videoWidth: 0, videoHeight: 0, error: null });
}

test("paused preparation waits for decoded data without starting playback", async () => {
  const video = media();
  let ready = false;
  const pending = waitForMediaReady(video).then(() => { ready = true; });
  Object.assign(video, { readyState: 1, videoWidth: 1920, videoHeight: 1080 });
  video.dispatchEvent(new Event("loadedmetadata"));
  await Promise.resolve();
  assert.equal(ready, false);
  video.readyState = 2;
  video.dispatchEvent(new Event("loadeddata"));
  await pending;
  assert.equal(ready, true);
});

test("cancellation releases a pending metadata wait", async () => {
  const controller = new AbortController();
  const pending = waitForMediaReady(media(), { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, { name: "AbortError" });
});

test("a proxy preparation failure releases the metadata wait with its original cause", async () => {
  const controller = new AbortController();
  const pending = waitForMediaReady(media(), { signal: controller.signal });
  const failure = new Error("source-input-exceeds-memory-capacity");
  controller.abort(failure);
  await assert.rejects(pending, error => error === failure);
});

test("an actual media error reports unsupported media", async () => {
  const video = media();
  const pending = waitForMediaReady(video, { unsupportedMessage: "Unsupported source" });
  video.error = { code: 4 };
  video.dispatchEvent(new Event("error"));
  await assert.rejects(pending, /Unsupported source/);
});

test("metadata is sufficient for a known compatible hidden output", async () => {
  const video = media();
  video.readyState = 1;
  await waitForMediaReady(video, { requirePicture: false });
});

test("a connection failure is recoverable rather than unsupported media", async () => {
  const video = media();
  video.error = { code: 2 };
  await assert.rejects(waitForMediaReady(video), { canRetry: true, message: "Media connection failed" });
});

test("already cancelled preparation does not accept cached media", async () => {
  const controller = new AbortController();
  controller.abort();
  const video = media();
  video.readyState = 2;
  await assert.rejects(waitForMediaReady(video, { signal: controller.signal }), { name: "AbortError" });
});
