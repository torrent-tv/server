import assert from "node:assert/strict";
import { mock, test } from "node:test";

/**
 * The forwarder installs itself on import and flushes on a two-second
 * interval, so the page around it is faked once for the whole file: a window
 * to install on, a document, a navigator without `sendBeacon`, and a `fetch`
 * that records what reached the registry server.
 */
mock.timers.enable({ apis: ["setInterval"] });
globalThis.window = Object.assign(new EventTarget(), { innerWidth: 1280, innerHeight: 720 });
globalThis.document = { visibilityState: "visible" };
Object.defineProperty(globalThis, "navigator", { value: { userAgent: "Mozilla/5.0 (Windows NT 10.0) Chrome/157" }, configurable: true });
/** @type {string[]} bodies the server accepted */
const toServer = [];
globalThis.fetch = async (_url, { body }) => {
  toServer.push(body);
  return { ok: true, status: 200 };
};
await import("../public/shared/client-logger.js");
const logger = /** @type {any} */ (globalThis.window).__ttvClientLogger;

/** Lines of the bodies, flattened. @param {string[]} bodies */
function messagesOf(bodies) {
  return bodies.flatMap((body) => JSON.parse(body).lines.map((line) => line.msg));
}

/** One interval tick, then the promise chains of the sends it started. */
async function flushOnce() {
  mock.timers.tick(2000);
  for (let turn = 0; turn < 10; turn++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

test("a closed proxy connection is not tried, and a reconnect takes the lines again", async () => {
  let open = true;
  /** @type {string[]} */
  const toProxy = [];
  logger.setProxySink({
    isOpen: () => open,
    send: async (body) => {
      if (!open) {
        throw new Error("Data channel is not open.");
      }
      toProxy.push(body);
      return { ok: true };
    }
  });

  await flushOnce();
  assert.ok(toProxy.length > 0, "while the connection is open the proxy takes the lines");
  const serverBefore = toServer.length;

  open = false;
  console.info("a line written after the connection closed");
  await flushOnce();
  const afterClose = messagesOf(toServer.slice(serverBefore));
  assert.ok(afterClose.includes("a line written after the connection closed"), "the server takes the lines");
  assert.ok(afterClose.some((msg) => msg.startsWith("[client-logger] the proxy connection is closed")), "the switch is said");
  assert.equal(afterClose.filter((msg) => msg.startsWith("[client-logger] since")).length, 0, "no batch failed on the dead connection");

  // Field 2026-10-08: with nothing else logged, the old forwarder still wrote a
  // failure line every two seconds for hours, each about the previous one.
  const quiet = toServer.length;
  await flushOnce();
  await flushOnce();
  await flushOnce();
  assert.equal(toServer.length, quiet, "a quiet page sends nothing");

  // A reconnect swaps the connection inside the same transport, so the same
  // sink opens again.
  open = true;
  const proxyBefore = toProxy.length;
  console.info("a line written after the reconnect");
  await flushOnce();
  assert.equal(toServer.length, quiet, "the server is not used once the connection is open again");
  assert.ok(messagesOf(toProxy.slice(proxyBefore)).includes("a line written after the reconnect"));
});

test("a WebRTC transport is as open as the connection it holds now", async () => {
  const { ProxyTransport } = await import("../public/domain/proxy-transport.js");
  const closed = { isOpen: false, fetch: async () => ({ ok: true }) };
  const opened = { isOpen: true, fetch: async () => ({ ok: true }) };
  const transport = ProxyTransport.fromWebRtc(/** @type {any} */ (closed));
  assert.equal(transport.isOpen, false);
  transport.replaceWebRtcProxy(/** @type {any} */ (opened));
  assert.equal(transport.isOpen, true);
  assert.equal(ProxyTransport.fromHttp("http://192.168.1.5:9090").isOpen, true);
});
