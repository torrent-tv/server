import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { subtitleStartHold } from "../public/domain/subtitle-start.js";

// The start waits for the proxy to say the trajectory is safe, and the piece
// that makes it safe is one the page appends. Asked only every 1.5 s, the
// answer came up to 1.5 s after that piece: r68 (torrent-tv/meta#178). The
// production method runs here without a browser, transport or player.
const source = readFileSync(new URL("../public/components/loading/loading.js", import.meta.url), "utf8").replaceAll("\r\n", "\n");
function method(name) {
  const start = source.indexOf(`  async ${name}(`);
  assert.ok(start >= 0, name);
  return source.slice(start, source.indexOf("\n  }\n", start) + 4);
}
const waitEstimateHelperStart = source.indexOf("function waitEstimateForProgress(");
const waitEstimateHelperEnd = source.indexOf("\n}", source.indexOf("function withProgressWaitEstimate(", waitEstimateHelperStart)) + 2;
const waitEstimateHelper = source.slice(waitEstimateHelperStart, waitEstimateHelperEnd);

class HTMLVideoElement { constructor() { this.paused = true; this.error = null; } }

test("forwards the active estimate nested in playback readiness to the waiting overlay", () => {
  const forward = new Function(`${waitEstimateHelper}\nreturn withProgressWaitEstimate;`)();
  const estimate = { version: 1, waitId: "source:0:1", revision: 7, remainingSeconds: 3.5, ageMs: 125 };
  const stats = { downloadSpeed: 100 };

  assert.deepEqual(forward(stats, { playbackReadiness: { waitEstimate: estimate } }), {
    ...stats,
    waitEstimate: estimate
  });
});

test("prefers the explicit progress estimate when both forms are present", () => {
  const forward = new Function(`${waitEstimateHelper}\nreturn withProgressWaitEstimate;`)();
  const explicit = { version: 1, waitId: "source:0:1", revision: 7, remainingSeconds: 3.5, ageMs: 125 };
  const nested = { ...explicit, revision: 6 };

  assert.deepEqual(forward(null, { waitEstimate: explicit, playbackReadiness: { waitEstimate: nested } }), {
    waitEstimate: explicit
  });
});

test("the page asks again as soon as a piece has arrived, after reporting it", async () => {
  const calls = [];
  const Component = new Function("HTMLVideoElement", "reportNow", "bufferedAheadSeconds", "bufferedEndSeconds",
    "pauseWithoutIntent", "subtitleStartHold", "PROXY_EVENTS", "PREBUFFER_NUDGE_AFTER_MS", "document", "CustomEvent", "calls", "waitTrace", `${waitEstimateHelper}
    return class {
    #playbackEpoch = 0; #coldStart = null; #lastBufferedAhead = 0; #lastDownloadStats = null;
    #browserBufferLimitSeconds = null; #progressPollFailing = false;
    #waitingModel = { update: () => ({ cushionPercent: 0 }) };
    #hlsPlayer = { resumeLoadAt() {} };
    #subtitlePlayback = { startSelection: () => ({ state: "none" }) };
    #session = { fetchActiveTranscodeProgress: async () => {
      calls.push({ what: "ask", at: Date.now() });
      // The first answer holds the start; the piece arrives meanwhile.
      if (calls.filter(call => call.what === "ask").length === 1) {
        setTimeout(() => { this.#lastBufferedAhead = 6; }, 100);
        return { playbackReadiness: { version: 1, ready: false, reason: "minimum-safe-delay", delaySeconds: 0.2 } };
      }
      return { playbackReadiness: { version: 1, ready: true, reason: "trajectory-safe-now", delaySeconds: 0 } };
    } };
    async #fetchBufferingStats() { calls.push({ what: "stats", at: Date.now() }); return { downloadSpeed: 600_000 }; }
    #throwIfCancelled() {}
    #logEvt() {}
    #logColdStart() {}
    #setPhaseProgress() {}
    #assertTranscodeProgress() {}
    ${method("#waitForPrebuffer")}
    wait(video) { return this.#waitForPrebuffer(video); }
  }`)(HTMLVideoElement, () => calls.push({ what: "report", at: Date.now() }), () => 0, () => 0, () => {}, subtitleStartHold,
    { MEASURED: "measured" }, 60_000, { dispatchEvent() {} }, class { constructor(type, init) { this.type = type; this.detail = init?.detail; } }, calls, { event() {}, run(_name, action) { return action(); } });
  const component = new Component();
  const startedAt = Date.now();
  await component.wait(new HTMLVideoElement());
  const asks = calls.filter(call => call.what === "ask");
  assert.equal(asks.length, 2);
  assert.ok(asks[1].at - startedAt < 1000, `asked again after ${asks[1].at - startedAt} ms, not on the 1.5 s poll`);
  const order = calls.filter(call => call.what !== "stats");
  assert.equal(order.at(-2).what, "report", "the report of the new buffer went before the question");
});

test("the supply row is read again with each answer the start waits on", async () => {
  // Home Assistant 2026-10-26 (torrent-tv/meta#239): read once while the file
  // opened, "1.7 MB/s • 0 B of 2 B needed" stood for a twelve-minute wait.
  const calls = [];
  const published = [];
  const Component = new Function("HTMLVideoElement", "reportNow", "bufferedAheadSeconds", "bufferedEndSeconds",
    "pauseWithoutIntent", "subtitleStartHold", "PROXY_EVENTS", "PREBUFFER_NUDGE_AFTER_MS", "document", "CustomEvent", "calls", "waitTrace", `${waitEstimateHelper}
    return class {
    #playbackEpoch = 0; #coldStart = null; #lastBufferedAhead = 0; #lastDownloadStats = { downloadSpeed: 1_700_000, resumeNeededBytes: 2, resumeDownloadedBytes: 0 };
    #browserBufferLimitSeconds = null; #progressPollFailing = false;
    #waitingModel = { update: () => ({ cushionPercent: 0 }) };
    #hlsPlayer = { resumeLoadAt() {} };
    #subtitlePlayback = { startSelection: () => ({ state: "none" }) };
    #asked = 0;
    #session = { fetchActiveTranscodeProgress: async () => {
      calls.push({ what: "ask" });
      this.#asked += 1;
      if (this.#asked === 1) setTimeout(() => { this.#lastBufferedAhead = 6; }, 50);
      return this.#asked === 1
        ? { playbackReadiness: { version: 1, ready: false, reason: "minimum-safe-delay", delaySeconds: 433 } }
        : { playbackReadiness: { version: 1, ready: true, reason: "trajectory-safe-now", delaySeconds: 0 } };
    } };
    async #fetchBufferingStats(operations) { calls.push({ what: "stats", operations }); return { downloadSpeed: 600_000 }; }
    #throwIfCancelled() {}
    #logEvt() {}
    #logColdStart() {}
    #setPhaseProgress() {}
    #assertTranscodeProgress() {}
    ${method("#waitForPrebuffer")}
    wait(video) { return this.#waitForPrebuffer(video); }
  }`)(HTMLVideoElement, () => {}, () => 0, () => 0, () => {}, subtitleStartHold,
    { MEASURED: "measured" }, 60_000, { dispatchEvent(event) { published.push(event.detail); } },
    class { constructor(type, init) { this.type = type; this.detail = init?.detail; } }, calls,
    { event() {}, run(_name, action) { return action(); } });
  await new Component().wait(new HTMLVideoElement());
  assert.deepEqual(calls.map(call => call.what), ["ask", "stats", "ask", "stats"]);
  const shown = published.map(detail => detail?.downloadStats).filter(Boolean);
  assert.ok(shown.length > 0 && shown.every(stats => stats.downloadSpeed === 600_000 && !("resumeNeededBytes" in stats)),
    "every published supply row is the fresh one, not the snapshot taken while the file opened");
});
