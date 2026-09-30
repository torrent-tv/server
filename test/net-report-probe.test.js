import assert from "node:assert/strict";
import test from "node:test";
import { recordNetSample, reportNow, startNetReporter, stopNetReporter } from "../public/domain/net-report.js";

test("refreshes a stale startup link and reports the measurement age", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "Date"], now: Date.now() });
  t.after(stopNetReporter);
  recordNetSample(1_000_000, 100);
  const reports = [];
  let probes = 0;
  startNetReporter({
    transport: { fetch: async (path, options) => {
      if (path.includes("link-probe")) {
        probes += 1;
        return { transferMs: 100, arrayBuffer: async () => new ArrayBuffer(65_536) };
      }
      reports.push(JSON.parse(options.body));
    } },
    sessionId: "waiting",
    getBufferedAheadSec: () => 19.187,
    getPlaying: () => false,
    getWaiting: () => true
  });
  assert.equal(probes, 0);
  t.mock.timers.tick(31_500);
  await new Promise(setImmediate);
  assert.equal(probes, 2);
  assert.ok(reports.at(-1).linkSampleAgeMs >= 30_000);
  reportNow();
  assert.equal(reports.at(-1).linkSampleMbps, 5.24288);
  t.mock.timers.tick(1_500);
  await new Promise(setImmediate);
  assert.equal(probes, 2);
});

test("stopping a reporter cancels its probe without recording a late sample", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "Date"], now: Date.now() });
  t.after(stopNetReporter);
  recordNetSample(1_000_000, 100);
  let finishProbe;
  let probeSignal;
  let probes = 0;
  startNetReporter({
    transport: { fetch: (path, options) => {
      if (path.includes("link-probe")) {
        probes += 1;
        probeSignal = options.signal;
        return new Promise((resolve) => { finishProbe = resolve; });
      }
      return Promise.resolve();
    } },
    sessionId: "cancelled",
    getBufferedAheadSec: () => 0,
    getPlaying: () => false,
    getWaiting: () => true
  });
  t.mock.timers.tick(31_500);
  assert.equal(probes, 1);
  t.mock.timers.tick(31_500);
  assert.equal(probes, 1);
  stopNetReporter();
  assert.equal(probeSignal.aborted, true);
  finishProbe({ transferMs: 100, arrayBuffer: async () => new ArrayBuffer(65_536) });
  await new Promise(setImmediate);
  let report;
  startNetReporter({
    transport: { fetch: async (_path, options) => { report = JSON.parse(options.body); } },
    sessionId: "next",
    getBufferedAheadSec: () => 0
  });
  assert.equal(report.linkSampleMbps, 80);
});
