import assert from "node:assert/strict";
import test from "node:test";
import { TorrentSession } from "../public/domain/torrent-session.js";

test("preserves returned snapshot ages after a delayed progress request", async (t) => {
  let now = 10_000;
  t.mock.method(performance, "now", () => now);
  const initial = { version: 1, waitId: "source:0:1", revision: 4, remainingSeconds: 8, ageMs: 10 };
  const session = new TorrentSession(() => {});
  session.activeProgressPoll = {
    progressUrl: "https://proxy.invalid/transcode/session/progress",
    fetchFn: async () => {
      now += 12_000;
      return {
        ok: true,
        json: async () => ({ waitEstimate: initial,
          playbackReadiness: { version: 1, ready: false, waitEstimate: initial } })
      };
    }
  };

  const progress = await session.fetchActiveTranscodeProgress();

  assert.equal(progress.playbackReadiness.waitEstimate.waitId, initial.waitId);
  assert.equal(progress.playbackReadiness.waitEstimate.revision, initial.revision);
  assert.equal(progress.waitEstimate.ageMs, initial.ageMs);
  assert.equal(progress.playbackReadiness.waitEstimate.ageMs, initial.ageMs);
});
