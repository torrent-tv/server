import assert from "node:assert/strict";
import test from "node:test";
import { TorrentSession } from "../public/domain/torrent-session.js";

test("ages the forecast nested in playback readiness by the progress response time", async () => {
  const initial = { version: 1, waitId: "source:0:1", revision: 4, remainingSeconds: 8, ageMs: 10 };
  const session = new TorrentSession(() => {});
  session.activeProgressPoll = {
    progressUrl: "https://proxy.invalid/transcode/session/progress",
    fetchFn: async () => {
      await new Promise(resolve => setTimeout(resolve, 10));
      return {
        ok: true,
        json: async () => ({ playbackReadiness: { version: 1, ready: false, waitEstimate: initial } })
      };
    }
  };

  const progress = await session.fetchActiveTranscodeProgress();

  assert.equal(progress.playbackReadiness.waitEstimate.waitId, initial.waitId);
  assert.equal(progress.playbackReadiness.waitEstimate.revision, initial.revision);
  assert.ok(progress.playbackReadiness.waitEstimate.ageMs >= initial.ageMs + 8,
    `expected network/response age to be added, got ${progress.playbackReadiness.waitEstimate.ageMs} ms`);
});
