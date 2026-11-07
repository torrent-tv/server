import test from "node:test";
import assert from "node:assert/strict";
import { WaitingModel } from "../public/domain/waiting-model.js";
import { formatWaitingText } from "../public/domain/waiting-text.js";

function readiness(overrides = {}) {
  return { version: 1, ready: false, delaySeconds: 7.5, bufferedSeconds: 2, reserveSeconds: 10, ...overrides };
}

test("does not present a numeric ETA from partial proxy readiness", () => {
  const model = new WaitingModel();
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
