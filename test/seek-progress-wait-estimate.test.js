import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../public/components/loading/loading.js", import.meta.url), "utf8").replaceAll("\r\n", "\n");
function method(name) {
  const start = source.indexOf(`  ${name}`);
  assert.ok(start >= 0, name);
  return source.slice(start, source.indexOf("\n  }\n", start) + 4);
}
const helperStart = source.indexOf("function waitEstimateForProgress(");
const helperEnd = source.indexOf("\n}", helperStart) + 2;
const waitEstimateHelper = source.slice(helperStart, helperEnd);
const publishMethod = method("#publishTranscodeMeasurements(progress) {");
const holdMethod = method("async #holdSeekUntilReady(seq, epoch, reportedAt) {");

function publisher(events) {
  const Component = new Function("document", "CustomEvent", "PROXY_EVENTS", "waitEstimateForProgress", `
    return class {
      #lastDownloadStats = { downloadSpeed: 120 };
      ${publishMethod}
      publish(progress) { this.#publishTranscodeMeasurements(progress); }
    };
  `);
  const Generated = Component({ dispatchEvent: event => events.push(event) },
    class { constructor(type, init) { this.type = type; this.detail = init?.detail; } },
    { MEASURED: "measured" }, new Function(`${waitEstimateHelper}\nreturn waitEstimateForProgress;`)());
  return new Generated();
}

test("seek readiness publishes its estimate to the waiting overlay", () => {
  const events = [];
  const estimate = { version: 1, waitId: "source:0:4", revision: 3, remainingSeconds: 8.5, ageMs: 240 };
  publisher(events).publish({ playbackReadiness: { version: 1, ready: false, waitEstimate: estimate } });

  assert.equal(events.length, 1);
  assert.equal(events[0].type, "measured");
  assert.equal(events[0].detail.downloadStats.downloadSpeed, 120);
  assert.deepEqual(events[0].detail.downloadStats.waitEstimate, estimate);
  assert.equal(events[0].detail.playbackReadiness.waitEstimate, estimate);
});

test("a readiness answer without an estimate clears the waiting overlay's prior value", () => {
  const events = [];
  publisher(events).publish({ playbackReadiness: { version: 1, ready: false } });

  assert.equal(events[0].detail.downloadStats.waitEstimate, null);
});

test("each seek-hold progress answer is sent through the waiting overlay event", () => {
  assert.match(holdMethod, /this\.#publishTranscodeMeasurements\(progress\);/);
});
