import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { WaitingModel } from "../public/domain/waiting-model.js";
import { formatWaitingText } from "../public/domain/waiting-text.js";

// What the viewer reads on the waiting screen comes from the proxy's
// `playbackReadiness`, through `WaitingModel`, into `formatWaitingText`. The
// production event handler runs here without a browser, for a cold start (the
// first frame has not been shown) and for a seek (it has).
const source = readFileSync(new URL("../public/components/waiting/waiting.js", import.meta.url), "utf8").replaceAll("\r\n", "\n");
const start = source.indexOf("  #onProxyMeasured = (event) => {");
assert.ok(start >= 0, "#onProxyMeasured");
const handler = source.slice(start, source.indexOf("\n  };", start) + 5);

class FakeCustomEvent { constructor(type, init) { this.type = type; this.detail = init?.detail; } }

function overlay({ awaitingFirstPresentedFrame, waitSequence }) {
  const shown = [];
  const Overlay = new Function("CustomEvent", "WaitingModel", "shown", `
    return class {
      #awaitingFirstPresentedFrame = ${awaitingFirstPresentedFrame};
      #waitSequence = ${waitSequence};
      #lastWaitEstimateTraceKey = null;
      #bufferedAhead = null;
      #measurements = {};
      #model = new WaitingModel();
      #applyStep() {}
      #render() { shown.push({ ...this.#measurements }); }
      ${handler}
      receive(event) { this.#onProxyMeasured(event); }
    };
  `)(FakeCustomEvent, WaitingModel, shown);
  const instance = new Overlay();
  return { shown, receive: detail => instance.receive(new FakeCustomEvent("measured", { detail })) };
}

const readiness = { version: 1, ready: false, reason: "minimum-safe-delay", delaySeconds: 7.5,
  bufferedSeconds: 2, reserveSeconds: 10 };

for (const [name, state] of [
  ["a cold start", { awaitingFirstPresentedFrame: true, waitSequence: 0 }],
  ["a seek after the first frame", { awaitingFirstPresentedFrame: false, waitSequence: 1 }]
]) {
  test(`${name} shows the readiness the proxy reported, with no total time`, () => {
    const screen = overlay(state);
    screen.receive({ downloadStats: { downloadSpeed: 500_000 }, transcodeProgress: { state: "running" },
      playbackReadiness: readiness });

    const measurements = screen.shown.at(-1);
    assert.equal(measurements.readinessReason, "minimum-safe-delay");
    assert.equal(measurements.etaSeconds, undefined);
    assert.equal(measurements.cushionPercent, 20);
    assert.equal(measurements.cushionRemainingSeconds, 8);
    const text = formatWaitingText(measurements);
    assert.match(text, /Playback readiness has not been confirmed/);
    assert.doesNotMatch(text, /until playback/);
  });

  test(`${name} keeps the reason until the next answer replaces it`, () => {
    const screen = overlay(state);
    const running = { state: "running" };
    screen.receive({ transcodeProgress: running, playbackReadiness: readiness });
    screen.receive({ transcodeProgress: running,
      playbackReadiness: { ...readiness, ready: true, reason: "trajectory-safe-now", delaySeconds: 0 } });

    const measurements = screen.shown.at(-1);
    assert.equal(measurements.readinessReason, "trajectory-safe-now");
    assert.equal(measurements.cushionPercent, 100);
  });
}
