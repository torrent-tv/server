import test from "node:test";
import assert from "node:assert/strict";
import { WebRtcProxy } from "../public/domain/webrtc-proxy.js";

// Fake signalling never emits a session and cannot create any peer or network.
function fakeSignalling(t) {
  const previousSocket = globalThis.WebSocket;
  const previousLocation = globalThis.location;
  const sockets = [];
  class Socket extends EventTarget {
    closed = 0;
    constructor() { super(); sockets.push(this); }
    close() { this.closed++; }
  }
  globalThis.WebSocket = Socket;
  globalThis.location = { protocol: "https:", host: "test.invalid" };
  t.after(() => {
    globalThis.WebSocket = previousSocket;
    globalThis.location = previousLocation;
  });
  return sockets;
}

test("closing an unfinished connection rejects it even without a socket close event", async t => {
  const sockets = fakeSignalling(t);
  const controller = new AbortController();
  const proxy = new WebRtcProxy("fake");
  const pending = proxy.connect(undefined, { signal: controller.signal });
  proxy.close();
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(sockets[0].closed, 1);
  controller.abort();
  assert.equal(sockets[0].closed, 1, "The cancellation listener must have been removed.");
});

test("cancelling connection preparation closes fake signalling and rejects immediately", async t => {
  const sockets = fakeSignalling(t);
  const controller = new AbortController();
  const proxy = new WebRtcProxy("fake");
  const pending = proxy.connect(undefined, { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(sockets[0].closed, 1);
});

test("already cancelled preparation creates no signalling socket", async t => {
  const sockets = fakeSignalling(t);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(new WebRtcProxy("fake").connect(undefined, { signal: controller.signal }), { name: "AbortError" });
  assert.equal(sockets.length, 0);
});
