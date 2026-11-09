import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import * as pictureHolds from "../public/domain/picture-holds.js";
import { subtitleStartHold } from "../public/domain/subtitle-start.js";
import { readinessTable } from "./fixtures/readiness-table.js";

// The start (`#waitForPrebuffer`) and the seek (`#holdSeekUntilReady`) read the
// same forecast alike: both release, wait or fail on it as the readiness gate
// says (torrent-tv/meta#289, AC-2). After a seek an answer without a forecast
// used to release the picture early, followed by a stall. The production
// methods run here without a browser, proxy or player, on a fake clock.

const gate = await import("../public/domain/readiness-gate.js").catch(error => ({ missing: error }));
const { PictureHolds, nextSeekHoldAsk } = pictureHolds;
const GAP_MESSAGE = "Prepared media contains a timestamp gap; playback cannot start.";

const source = readFileSync(new URL("../public/components/loading/loading.js", import.meta.url), "utf8").replaceAll("\r\n", "\n");
function method(signature) {
  const start = source.indexOf(`  ${signature}`);
  assert.ok(start >= 0, signature);
  // The retired progress-bar calls are not what these tests are about.
  return source.slice(start, source.indexOf("\n  }\n", start) + 4)
    .replace(/^[ \t]*this\.#set\w*Progress\([^\n]*\n/gm, "");
}
const pageHelpers = [...source.matchAll(/^function \w*[wW]aitEstimate\w*\(.*?^}$/gms)].map(match => match[0]).join("\n");
const startMethod = method("async #waitForPrebuffer(");
const seekMethod = method("async #holdSeekUntilReady(");

class HTMLVideoElement { constructor() { this.paused = true; this.error = null; } }
const waitTrace = { event() {}, open() { return () => {}; }, run(_name, action) { return action(); } };
class FakeEvent { constructor(type, init) { this.type = type; this.detail = init?.detail; } }

/** The gate the methods are handed, counting how often they consult it. */
function consultedGate() {
  const record = { calls: 0 };
  record.readinessVerdict = (...args) => {
    record.calls += 1;
    if (gate.missing) throw new Error(`public/domain/readiness-gate.js does not load: ${gate.missing.message}`);
    return gate.readinessVerdict(...args);
  };
  return record;
}

function assertDecidedByGate(consulted, where) {
  assert.equal(gate.missing, undefined, `public/domain/readiness-gate.js does not load: ${gate.missing?.message}`);
  assert.ok(consulted.calls > 0, `${where} decides through readinessVerdict`);
}

/**
 * Run the start's wait on one forecast. The proxy gives the same answer each
 * time it is asked; after the third question the playback is cancelled, which
 * is how a wait that never releases ends here.
 */
async function startOn(readiness) {
  const consulted = consultedGate();
  const harness = { clock: 10_000, asks: 0, published: [], modelUpdates: [], subtitleHoldEnds: 0 };
  const Component = new Function("HTMLVideoElement", "reportNow", "bufferedAheadSeconds", "bufferedEndSeconds",
    "pauseWithoutIntent", "subtitleStartHold", "readinessVerdict", "PROXY_EVENTS", "PREBUFFER_NUDGE_AFTER_MS",
    "document", "CustomEvent", "waitTrace", "setTimeout", "Date", "performance", "harness", `${pageHelpers}
    return class {
    #playbackEpoch = 0; #coldStart = null; #lastBufferedAhead = 0; #lastDownloadStats = null;
    #browserBufferLimitSeconds = null; #progressPollFailing = false;
    #waitingModel = { update: (facts) => { harness.modelUpdates.push(facts); return { cushionPercent: 0 }; } };
    #hlsPlayer = { resumeLoadAt() { return false; } };
    #subtitlePlayback = { startSelection: () => ({ state: "none" }) };
    #session = { fetchActiveTranscodeProgress: async () => {
      harness.asks += 1;
      return harness.answer();
    } };
    async #fetchBufferingStats() { return { downloadSpeed: 600_000 }; }
    #throwIfCancelled() {
      if (harness.asks >= 3) throw Object.assign(new Error("cancelled"), { name: "AbortError" });
    }
    #logEvt() {}
    #logColdStart() {}
    #assertTranscodeProgress() {}
    ${startMethod}
    wait(video) { return this.#waitForPrebuffer(video); }
  }`)(HTMLVideoElement, () => {}, () => 0, () => 0, () => {}, subtitleStartHold, consulted.readinessVerdict,
    { MEASURED: "measured" }, 60_000, { dispatchEvent: event => harness.published.push(event.detail) }, FakeEvent,
    waitTrace,
    (callback, ms) => { harness.clock += ms; queueMicrotask(callback); return 0; },
    { now: () => harness.clock }, { now: () => harness.clock }, harness);
  harness.answer = () => (readiness === undefined ? {} : { playbackReadiness: readiness });
  let outcome;
  let error = null;
  try {
    await new Component().wait(new HTMLVideoElement());
    outcome = "release";
  } catch (caught) {
    error = caught;
    outcome = caught?.name === "AbortError" ? "wait" : "fail";
  }
  return { outcome, error, consulted, ...harness };
}

/**
 * Run a seek's hold on a run of answers. When the answers run out, the next
 * question ends the playback, which is how a hold that never releases ends here.
 */
async function seekOn(answers, { firstRequestAt = 100, reportedAt = 100 } = {}) {
  const consulted = consultedGate();
  const signals = [];
  const holds = new PictureHolds({ held: () => signals.push("held"), released: () => signals.push("released") });
  const seq = holds.beginSeek();
  const harness = { clock: firstRequestAt, asks: [], waits: [], failures: [], modelUpdates: [], published: [], holds, seq };
  const Component = new Function("HTMLVideoElement", "bufferedAheadSeconds", "readinessVerdict", "seekHoldAnswer",
    "nextSeekHoldAsk", "waitTrace", "setTimeout", "performance", "harness", `
    return class {
    #playbackEpoch = 0; #progressPollFailing = false; #videoElement = null;
    #holds = harness.holds;
    #waitingModel = { update: (facts) => { harness.modelUpdates.push(facts); return {}; } };
    #session = { fetchActiveTranscodeProgress: async () => {
      harness.asks.push({ held: harness.holds.holdsSeek(harness.seq) });
      const index = harness.asks.length - 1;
      harness.clock = Math.max(harness.clock + 1, ${reportedAt});
      if (index >= harness.answers.length) {
        this.#playbackEpoch += 1;
        return null;
      }
      const readiness = harness.answers[index];
      return readiness === undefined ? {} : { playbackReadiness: readiness };
    } };
    #publishTranscodeMeasurements(progress) { harness.published.push(progress); }
    #logEvt() {}
    #untilMediaArrivesOr(ms) { harness.waits.push(ms); return Promise.resolve(); }
    #failWith(epoch, error) { harness.failures.push({ epoch, error }); }
    ${seekMethod}
    hold(seq, reportedAt) { return this.#holdSeekUntilReady(seq, 0, reportedAt); }
  }`)(HTMLVideoElement, () => 0, consulted.readinessVerdict, pictureHolds.seekHoldAnswer, nextSeekHoldAsk, waitTrace,
    (callback) => { queueMicrotask(callback); return 0; }, { now: () => harness.clock }, harness);
  harness.answers = answers;
  await new Component().hold(seq, reportedAt);
  return { ...harness, signals, consulted, released: !holds.holdsSeek(seq) && signals.at(-1) === "released" };
}

for (const row of readinessTable) {
  test(`the readiness gate itself gives the table's verdict for ${row.name}`, () => {
    assert.equal(gate.missing, undefined, `public/domain/readiness-gate.js does not load: ${gate.missing?.message}`);
    assert.equal(gate.readinessVerdict({ readiness: row.readiness }).verdict, row.verdict);
  });

  test(`the start gives the table's verdict for ${row.name}`, async () => {
    const run = await startOn(row.readiness);
    assert.equal(run.outcome, row.verdict, `start on ${row.name}${run.error ? `: ${run.error.message}` : ""}`);
    if (row.verdict === "release") assert.equal(run.asks, 1, "released on the first answer");
    if (row.verdict === "wait") {
      assert.equal(run.asks, 3, "kept asking until the playback was cancelled");
      assert.ok(run.published.length > 0, "the forecast it waits on is published to the overlay");
      assert.ok(run.published.every(detail => detail.playbackReadiness === (row.readiness ?? null)),
        "the overlay is given the proxy's own forecast");
    }
    if (row.verdict === "fail") assert.equal(run.error.message, GAP_MESSAGE);
    assertDecidedByGate(run.consulted, "the start");
  });

  test(`the seek gives the table's verdict for ${row.name}`, async () => {
    const run = await seekOn([row.readiness]);
    if (row.verdict === "release") {
      assert.equal(run.asks.length, 1, "released on the first answer, without asking again");
      assert.deepEqual(run.failures, []);
      assert.equal(run.released, true, "the seek lets the picture go");
    }
    if (row.verdict === "wait") {
      assert.equal(run.asks.length, 2, "the seek asks again instead of releasing the picture");
      assert.equal(run.asks[1].held, true, "the picture is still held after the answer");
      assert.deepEqual(run.failures, []);
      assert.equal(run.waits.length, 1, "it waits before asking again");
      assert.equal(run.waits[0], nextSeekHoldAsk(row.readiness, 1500));
    }
    if (row.verdict === "fail") {
      assert.equal(run.failures.length, 1, "a timestamp gap after a seek fails playback");
      assert.equal(run.failures[0].epoch, 0);
      assert.equal(run.failures[0].error.message, GAP_MESSAGE, "with the same message as at start");
      assert.equal(run.asks.length, 1, "and asks no more");
      assert.equal(run.released, true, "the seek's hold is let go");
    }
    assert.ok(run.modelUpdates.length > 0 && run.modelUpdates[0].playbackReadiness === (row.readiness ?? null),
      "the answer is published to the waiting model");
    assertDecidedByGate(run.consulted, "the seek");
  });
}

test("a seek does not read an answer asked for before the seek was reported, and asks again", async () => {
  const run = await seekOn([{ version: 1, ready: true, reason: "trajectory-safe-now" }], { firstRequestAt: 99, reportedAt: 100 });
  assert.equal(run.asks.length, 2, "the stale ready answer does not release the picture");
  assert.equal(run.asks[1].held, true);
  assert.deepEqual(run.modelUpdates, [], "a stale answer is not published");
  assert.deepEqual(run.waits, [], "it asks again at once");
  assert.deepEqual(run.failures, []);
  assertDecidedByGate(run.consulted, "the seek");
});

test("a stale timestamp gap after a seek does not fail playback", async () => {
  const run = await seekOn([{ version: 1, ready: false, reason: "media-continuity-unavailable" }], { firstRequestAt: 99, reportedAt: 100 });
  assert.deepEqual(run.failures, []);
  assert.equal(run.asks.length, 2);
  assertDecidedByGate(run.consulted, "the seek");
});

test("a seek answered first without a forecast is released only by the ready answer that follows", async () => {
  const run = await seekOn([null, { version: 1, ready: true, reason: "trajectory-safe-now", reserveSeconds: 6 }]);
  assert.equal(run.asks.length, 2, "the null answer did not release the picture");
  assert.equal(run.asks[1].held, true, "still held when asked the second time");
  assert.equal(run.released, true, "the ready answer releases it");
  assert.deepEqual(run.failures, []);
  assertDecidedByGate(run.consulted, "the seek");
});
