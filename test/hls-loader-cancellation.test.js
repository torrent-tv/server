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
