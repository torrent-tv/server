import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { readinessTable } from "./fixtures/readiness-table.js";

// One reading of the proxy's playback forecast (`playbackReadiness`) decides
// whether the picture may move, at start and after a seek
// (torrent-tv/meta#289). A forecast that is missing, null or of a version the
// page does not know never releases the picture; an answer asked for before
// the seek was reported is not read.

const gate = await import("../public/domain/readiness-gate.js").catch(error => ({ missing: error }));

function verdictOf(answer) {
  assert.equal(gate.missing, undefined, `public/domain/readiness-gate.js does not load: ${gate.missing?.message}`);
  assert.equal(typeof gate.readinessVerdict, "function", "public/domain/readiness-gate.js exports readinessVerdict");
  return answer === undefined ? gate.readinessVerdict() : gate.readinessVerdict(answer);
}

const ready = { version: 1, ready: true, reason: "trajectory-safe-now", delaySeconds: 0 };
const notReady = { version: 1, ready: false, reason: "minimum-safe-delay", delaySeconds: 4 };

test("every row of the shared table gets its verdict", () => {
  for (const row of readinessTable) {
    const { verdict } = verdictOf({ readiness: row.readiness });
    assert.equal(verdict, row.verdict, row.name);
  }
});

test("a ready forecast releases with the proxy's reason", () => {
  assert.deepEqual(verdictOf({ readiness: ready }), { verdict: "release", reason: "trajectory-safe-now" });
});

test("a forecast that is not ready waits with the proxy's reason", () => {
  assert.deepEqual(verdictOf({ readiness: notReady }), { verdict: "wait", reason: "minimum-safe-delay" });
});

test("a ready forecast waits while the start subtitle is still being read", () => {
  assert.deepEqual(verdictOf({ readiness: ready, subtitleHold: "subtitles-pending" }),
    { verdict: "wait", reason: "subtitles-pending" });
});

test("a proxy that cannot say whether the subtitle was read does not hold a ready forecast", () => {
  assert.deepEqual(verdictOf({ readiness: ready, subtitleHold: "proxy-unaware" }),
    { verdict: "release", reason: "trajectory-safe-now" });
});

test("a null forecast waits as missing", () => {
  assert.deepEqual(verdictOf({ readiness: null }), { verdict: "wait", reason: "forecast-missing" });
});

test("an absent forecast waits as missing", () => {
  assert.deepEqual(verdictOf({ readiness: undefined }), { verdict: "wait", reason: "forecast-missing" });
  assert.deepEqual(verdictOf({}), { verdict: "wait", reason: "forecast-missing" });
});

test("a forecast that is not an object waits as missing", () => {
  assert.deepEqual(verdictOf({ readiness: "ready" }), { verdict: "wait", reason: "forecast-missing" });
  assert.deepEqual(verdictOf({ readiness: 1 }), { verdict: "wait", reason: "forecast-missing" });
});

test("a forecast of another or no version waits as unsupported, even when it says ready", () => {
  for (const readiness of [{ ...ready, version: 0 }, { ...ready, version: 2 }, { ready: true, reason: "trajectory-safe-now" }]) {
    assert.deepEqual(verdictOf({ readiness }), { verdict: "wait", reason: "forecast-version-unsupported" },
      JSON.stringify(readiness));
  }
});

test("a timestamp gap in the prepared media fails", () => {
  assert.deepEqual(verdictOf({ readiness: { version: 1, ready: false, reason: "media-continuity-unavailable" } }),
    { verdict: "fail", reason: "media-continuity-unavailable" });
});

test("a forecast that is not ready and gives no reason waits as unavailable", () => {
  assert.deepEqual(verdictOf({ readiness: { version: 1, ready: false } }),
    { verdict: "wait", reason: "forecast-unavailable" });
});

test("an answer asked for at the moment the seek was reported is read", () => {
  assert.deepEqual(verdictOf({ readiness: ready, requestedAt: 10, reportedAt: 10 }),
    { verdict: "release", reason: "trajectory-safe-now" });
});

test("an answer asked for before the seek was reported is stale, whatever it says", () => {
  assert.deepEqual(verdictOf({ readiness: ready, requestedAt: 9, reportedAt: 10 }),
    { verdict: "stale", reason: "asked-before-seek-reported" });
  assert.equal(verdictOf({ readiness: null, requestedAt: 9, reportedAt: 10 }).verdict, "stale");
});

test("an answer with no request time is stale against a reported seek", () => {
  assert.equal(verdictOf({ readiness: ready, reportedAt: 10 }).verdict, "stale");
  assert.equal(verdictOf({ readiness: ready, requestedAt: Number.NaN, reportedAt: 10 }).verdict, "stale");
});

test("without a reported seek no answer is stale", () => {
  assert.equal(verdictOf({ readiness: ready, requestedAt: 1 }).verdict, "release");
  assert.equal(verdictOf({ readiness: ready }).verdict, "release");
});

test("a stale timestamp gap is not read, so it does not fail playback", () => {
  assert.deepEqual(verdictOf({ readiness: { version: 1, ready: false, reason: "media-continuity-unavailable" },
    requestedAt: 9, reportedAt: 10 }), { verdict: "stale", reason: "asked-before-seek-reported" });
});

test("a ready forecast with no reason releases as ready", () => {
  assert.deepEqual(verdictOf({ readiness: { version: 1, ready: true } }), { verdict: "release", reason: "ready" });
});

test("the answer it reads is left as it was", () => {
  const readiness = Object.freeze({ ...ready, subtitles: Object.freeze({ fileIndex: 0, trackIndex: 2 }) });
  const answer = Object.freeze({ readiness, requestedAt: 11, reportedAt: 10, subtitleHold: "subtitles-pending" });
  const before = JSON.stringify(answer);
  verdictOf(answer);
  assert.equal(JSON.stringify(answer), before);
});

test("called with nothing it waits as missing", () => {
  assert.deepEqual(verdictOf(undefined), { verdict: "wait", reason: "forecast-missing" });
});

// AC-1: no other page code reads the forecast's version. The chapter answer
// has a contract version of its own and is not this forecast.
test("only the readiness gate reads the forecast's version", () => {
  const root = fileURLToPath(new URL("../public/", import.meta.url));
  const files = [];
  const walk = dir => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "vendor") walk(path);
      } else {
        files.push(path);
      }
    }
  };
  walk(root);
  const matching = files
    .map(path => relative(root, path).split("\\").join("/"))
    .filter(path => path !== "domain/chapter-metadata.js")
    .filter(path => /version [!=]== 1/.test(readFileSync(join(root, path), "utf8")));
  assert.deepEqual(matching, ["domain/readiness-gate.js"]);
});
