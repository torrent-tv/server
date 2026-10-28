import test from "node:test";
import assert from "node:assert/strict";
import { WaitingModel } from "../public/domain/waiting-model.js";
import { formatWaitingText } from "../public/domain/waiting-text.js";

function readiness(overrides = {}) {
  return { version: 1, ready: false, delaySeconds: 7.5, bufferedSeconds: 2, reserveSeconds: 10, ...overrides };
}

test("does not present a numeric ETA from partial proxy estimates", () => {
  const model = new WaitingModel();
  for (const remainingSeconds of [0, 1.75, 42_053.288]) {
    assert.equal(model.update({ waitEstimate: { version: 1, remainingSeconds } }).etaSeconds, null);
  }
  assert.equal(model.update({ playbackReadiness: readiness({ delaySeconds: 0.035 }) }).etaSeconds, null);
  assert.match(formatWaitingText({ etaSeconds: null, readinessReason: "minimum-safe-delay" }),
    /Playback readiness has not been confirmed/);
});

test("keeps the browser buffer cushion while total time remains unknown", () => {
  const model = new WaitingModel();
  const answer = model.update({ playbackReadiness: readiness(), bufferedAhead: 4 });

  assert.equal(answer.etaSeconds, null);
  assert.equal(answer.cushionPercent, 40);
  assert.equal(answer.cushionRemainingSeconds, 6);
});

test("a full browser buffer does not create a total-wait estimate", () => {
  const model = new WaitingModel();
  const answer = model.update({ playbackReadiness: readiness(), bufferedAhead: 10 });

  assert.equal(answer.etaSeconds, null);
  assert.equal(answer.cushionPercent, 100);
  assert.equal(answer.cushionRemainingSeconds, 0);
});
