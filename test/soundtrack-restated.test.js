/**
 * @file Restating the soundtrack after a reconnect, and what counts as kept.
 *
 * Field 2026-09-28: after a reconnect the proxy no longer knew the viewer and
 * served their AAC soundtrack as a copy under the same address; the player
 * ended its audio stream. The page now says its soundtrack again over the new
 * connection, and only an answer that says it was recorded lets it go on.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { TorrentSession } from "../public/domain/torrent-session.js";

/**
 * @param {(path: string) => Promise<object>} answer
 */
function sessionAnswering(answer) {
  const session = new TorrentSession(() => undefined);
  session.currentTranscodeSession = { sessionId: "30cfa2b9c6eee043", transport: null };
  session.statedSoundtrack = { trackIndex: 0, transcode: true };
  const paths = [];
  const transport = {
    fetch: async (path) => {
      paths.push(path);
      return answer(path);
    }
  };
  return { session, transport, paths };
}

const status = (code, body = null) => async () => ({ status: code, ok: code < 300, json: async () => body });

test("the stated soundtrack is said again, with what the browser needs for it", async () => {
  const { session, transport, paths } = sessionAnswering(status(204));
  assert.equal(await session.restateSoundtrack(1641.18, transport), "recorded");
  assert.equal(paths.length, 1);
  assert.match(paths[0], /^\/transcode\/30cfa2b9c6eee043\/a\/0\/warm\?position=1641\.180&consumer=.+&transcode=1$/);
});

test("still being made, and recorded, is kept", async () => {
  const { session, transport } = sessionAnswering(status(503, { error: "warming", warming: true }));
  assert.equal(await session.restateSoundtrack(10, transport), "recorded");
});

test("a 503 that does not say it recorded anything is a failure", async () => {
  const { session, transport } = sessionAnswering(status(503, { error: "Could not prepare the audio track: x" }));
  assert.equal(await session.restateSoundtrack(10, transport), "failed");
});

test("a proxy error and a connection that does not answer are failures", async () => {
  const erring = sessionAnswering(status(500));
  assert.equal(await erring.session.restateSoundtrack(10, erring.transport), "failed");
  const { session, transport } = sessionAnswering(async () => {
    throw new Error("Data channel request timed out.");
  });
  assert.equal(await session.restateSoundtrack(10, transport), "failed");
});

test("a session without a separate soundtrack has nothing to restate", async () => {
  const { session, transport } = sessionAnswering(status(404));
  assert.equal(await session.restateSoundtrack(10, transport), "nothing-to-restate");
});

test("a switch in place is what is said next time; an unstated need keeps the last one", () => {
  const session = new TorrentSession(() => undefined);
  session.statedSoundtrack = { trackIndex: 0, transcode: true };
  session.noteSoundtrackStated(2, false);
  assert.deepEqual(session.statedSoundtrack, { trackIndex: 2, transcode: false });
  session.noteSoundtrackStated(3, null);
  assert.deepEqual(session.statedSoundtrack, { trackIndex: 3, transcode: false });
});
