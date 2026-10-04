/**
 * @file The link measured when the page opens reaches the first report.
 *
 * The page measures its link the moment a transport is up, before a film is
 * chosen, so the proxy knows the link before the first segment. Field
 * 2026-10-03: the probe carried 2 MiB at 30-37 Mbit/s at 10:00:02, and every
 * report from 10:00:10 to 10:00:26 still said `link=?` — the reporter started
 * with an empty sample window, and the figure appeared only once segments had
 * been delivered.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { measureLink, startNetReporter, stopNetReporter } from "../public/domain/net-report.js";

test("the first report carries the link the opening probe measured", async () => {
  const posted = [];
  const transport = {
    async fetch(path, options = {}) {
      if (path.startsWith("/api/link-probe")) {
        const bytes = Number(new URL(path, "http://proxy").searchParams.get("bytes"));
        // 65536 bytes in 100 ms: measurable at once, 5.24 Mbit/s.
        return { ok: true, transferMs: 100, arrayBuffer: async () => new ArrayBuffer(bytes) };
      }
      posted.push(JSON.parse(options.body));
      return { ok: true };
    }
  };

  await measureLink(transport);
  startNetReporter({
    transport,
    sessionId: "session",
    getBufferedAheadSec: () => 0,
    getPlaying: () => false,
    getWaiting: () => true
  });
  stopNetReporter();

  assert.equal(posted.length, 1, "the reporter sends its first report at once");
  assert.ok(
    Math.abs(posted[0].linkMbps - (65536 * 8) / 0.1 / 1e6) < 1e-9,
    `the first report said linkMbps=${posted[0].linkMbps}, not the probe's figure`
  );
});
