import test from "node:test";
import assert from "node:assert/strict";
import { TorrentSession, waitForHlsPlaylist } from "../public/domain/torrent-session.js";

test("allocation has no production deadline and a terminal warmup refusal is not retried", async () => {
  const session = new TorrentSession();
  let requests = 0;
  await assert.rejects(session.tryCreateTranscodeSession({ fetch: async (_path, options) => {
    requests++;
    assert.equal(options.timeoutMs, 0);
    assert.equal(options.signal, session.abortController.signal);
    return Response.json({ error: "HLS playlist is still warming up", retryable: false }, { status: 500 });
  } }, "source", 0), error => error.canRetry === false);
  assert.equal(requests, 1);
});

test("a ready media playlist completes without a production deadline", async () => {
  await waitForHlsPlaylist("/playlist", { fetchFn: async () =>
    new Response("#EXTM3U\n#EXTINF:4,\nsegment.m4s", { status: 200 }) });
});

test("terminal playlist failures cannot automatically restart the output", async () => {
  for (const status of [404, 410, 422, 500, 503]) {
    let requests = 0;
    await assert.rejects(waitForHlsPlaylist("/playlist", { fetchFn: async () => {
      requests++;
      return Response.json({ error: "Unavailable sample", retryable: false }, { status });
    } }), error => error.isProxyRefusal === true && error.canRetry === false);
    assert.equal(requests, 1);
  }
});

test("a cancelled viewer does not request a playlist", async () => {
  await assert.rejects(waitForHlsPlaylist("/playlist", {
    signal: AbortSignal.abort(), fetchFn: () => assert.fail("cancelled viewer requested bytes")
  }), { name: "AbortError" });
});

test("cancellation interrupts a legacy pending-response delay", async () => {
  const cancellation = new AbortController();
  const waiting = waitForHlsPlaylist("/playlist", {
    signal: cancellation.signal,
    fetchFn: async () => new Response(null, { status: 202, headers: { "Retry-After": "3600" } })
  });
  await new Promise(resolve => setImmediate(resolve));
  cancellation.abort();
  await assert.rejects(waiting, { name: "AbortError" });
});
