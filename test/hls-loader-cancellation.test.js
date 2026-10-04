import test from "node:test";
import assert from "node:assert/strict";
import { createWebRtcHlsLoader } from "../public/domain/webrtc-hls-loader.js";

test("aborting a fragment cancels its transport and suppresses a late response", async () => {
  let reply;
  let signal;
  const Loader = createWebRtcHlsLoader({ fetch: (_path, options) => {
    signal = options.signal;
    return new Promise(resolve => { reply = resolve; });
  } }, "viewer", () => 2);
  const loader = new Loader();
  const calls = [];
  loader.load({ url: "http://webrtc-proxy/transcode/a/segment.mp4", responseType: "arraybuffer" }, {}, {
    onSuccess: () => calls.push("success"), onError: () => calls.push("error")
  });
  loader.abort();
  assert.equal(signal.aborted, true);
  reply({ ok: true, arrayBuffer: async () => new ArrayBuffer(1) });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, []);
});

test("reusing a loader cannot revive a response from its previous viewing", async () => {
  const requests = [];
  const Loader = createWebRtcHlsLoader({ fetch: (_path, options) => new Promise(resolve => {
    requests.push({ resolve, signal: options.signal });
  }) });
  const loader = new Loader();
  const calls = [];
  for (const name of ["first", "second"]) loader.load({ url: "http://webrtc-proxy/" + name }, {}, {
    onSuccess: () => calls.push(name), onError: () => calls.push("error")
  });
  assert.equal(requests[0].signal.aborted, true);
  requests[0].resolve({ ok: true, text: async () => "old" });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, []);
  loader.destroy();
  assert.equal(requests[1].signal.aborted, true);
});

test("a request whose connection was replaced is asked again, and the player never hears of it", async () => {
  const requests = [];
  const Loader = createWebRtcHlsLoader({ fetch: (path) => new Promise((resolve, reject) => {
    requests.push({ path, resolve, reject });
  }) }, "viewer", () => 1);
  const loader = new Loader();
  const calls = [];
  loader.load({ url: "http://webrtc-proxy/transcode/a/a/0/segment-00268.mp4", responseType: "arraybuffer" }, {}, {
    onSuccess: () => calls.push("success"), onError: (error) => calls.push(`error ${error.text}`)
  });
  const replaced = new Error("Data channel replaced by another connection.");
  replaced.name = "TransportReplacedError";
  requests[0].reject(replaced);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(requests.length, 2, "the same request went out again");
  assert.equal(requests[1].path, requests[0].path);
  assert.deepEqual(calls, []);
  requests[1].resolve({ ok: true, arrayBuffer: async () => new ArrayBuffer(4) });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, ["success"]);
});

test("any other failure still reaches the player once", async () => {
  const requests = [];
  const Loader = createWebRtcHlsLoader({ fetch: () => new Promise((resolve, reject) => {
    requests.push({ resolve, reject });
  }) });
  const loader = new Loader();
  const calls = [];
  loader.load({ url: "http://webrtc-proxy/transcode/a/segment.mp4", responseType: "arraybuffer" }, {}, {
    onSuccess: () => calls.push("success"), onError: (error) => calls.push(`error ${error.text}`)
  });
  requests[0].reject(new Error("Data channel request timed out."));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(requests.length, 1);
  assert.deepEqual(calls, ["error Data channel request timed out."]);
});
