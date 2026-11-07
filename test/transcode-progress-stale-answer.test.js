import assert from "node:assert/strict";
import test from "node:test";
import { TorrentSession } from "../public/domain/torrent-session.js";

test("discards a progress answer that arrives after a seek replaces its generation", async () => {
  let finish;
  let requestedUrl;
  let requestStarted;
  const started = new Promise(resolve => { requestStarted = resolve; });
  const response = new Promise(resolve => { finish = resolve; });
  const session = new TorrentSession(() => {});
  session.activeProgressPoll = {
    progressUrl: "https://proxy.invalid/api/transcode-sessions/session/progress?consumer=viewer&generation=0",
    fetchFn: (url) => { requestedUrl = url; requestStarted(); return response; }
  };

  const pending = session.fetchActiveTranscodeProgress();
  await started;
  await session.reportSeek(120);
  finish({ ok: true, status: 200, json: async () => ({ snapshotTransport: { generation: 0 } }) });

  assert.match(requestedUrl, /generation=0/);
  assert.equal(await pending, null);
});
