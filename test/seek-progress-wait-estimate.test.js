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
const waitingSource = readFileSync(new URL("../public/components/waiting/waiting.js", import.meta.url), "utf8").replaceAll("\r\n", "\n");
const receivedStart = waitingSource.indexOf("  #onProxyMeasured = (event) => {");
const receivedEnd = waitingSource.indexOf("\n  };", receivedStart) + 5;
const receivedMethod = waitingSource.slice(receivedStart, receivedEnd);

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
  assert.match(holdMethod, /waitTrace\.run\("S2\.5\.publish-transcode-readings",[\s\S]*this\.#publishTranscodeMeasurements\(progress\)/);
});

test("the active seek estimate is accepted after the startup wait has ended", () => {
  const modelInputs = [];
  const FakeCustomEvent = class { constructor(type, init) { this.type = type; this.detail = init?.detail; } };
  const Overlay = new Function("CustomEvent", "modelInputs", `
    return class {
      #awaitingFirstPresentedFrame = false;
      #waitSequence = 1;
      #lastWaitEstimateTraceKey = null;
      #bufferedAhead = null;
      #measurements = {};
      #model = { update: facts => { modelInputs.push(facts); return { etaSeconds: facts.waitEstimate?.remainingSeconds ?? null }; } };
      #applyStep() {}
      #render() {}
      ${receivedMethod}
      receive(event) { this.#onProxyMeasured(event); }
    };
  `)(FakeCustomEvent, modelInputs);
  const estimate = { version: 1, waitId: "source:0:1", revision: 1, remainingSeconds: 3.6, ageMs: 0 };
  const overlay = new Overlay();
  overlay.receive(new FakeCustomEvent("measured", {
    detail: { downloadStats: { waitEstimate: estimate }, playbackReadiness: { waitEstimate: estimate } }
  }));

  assert.deepEqual(modelInputs[0].waitEstimate, estimate);
});
