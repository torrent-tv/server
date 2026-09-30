import test from "node:test";
import assert from "node:assert/strict";
import { WaitingModel } from "../public/domain/waiting-model.js";
import { formatWaitingText } from "../public/domain/waiting-text.js";

function readiness(overrides = {}) {
  return {
    version: 1,
    ready: false,
    delaySeconds: 7.5,
    bufferedSeconds: 2,
    reserveSeconds: 10,
    ...overrides
  };
}

test("does not invent an estimate before the proxy reports its forecast", () => {
  const model = new WaitingModel();
  const answer = model.update({});

  assert.equal(answer.etaSeconds, null);
  assert.equal(answer.cushionPercent, null);
  assert.equal(answer.cushionRemainingSeconds, null);
});

test("shows the proxy's delay and the browser's current buffer", () => {
  const model = new WaitingModel();
  const answer = model.update({
    playbackReadiness: readiness(),
    bufferedAhead: 4
  });

  assert.equal(answer.etaSeconds, 7.5);
  assert.equal(answer.cushionPercent, 40);
  assert.equal(answer.cushionRemainingSeconds, 6);
});

test("keeps an unavailable proxy delay unknown in the waiting text", () => {
  const model = new WaitingModel();
  model.update({ playbackReadiness: readiness() });
  const answer = model.update({
    playbackReadiness: readiness({ delaySeconds: null, reason: "segment-size-unavailable" })
  });

  assert.equal(answer.etaSeconds, null);
  assert.equal(formatWaitingText({ etaSeconds: answer.etaSeconds }), "Estimating…");
  assert.equal(model.update({ bufferedAhead: 4 }).etaSeconds, null);
});

test("accepts only finite nonnegative numeric delays", () => {
  const model = new WaitingModel();
  for (const delaySeconds of [undefined, "0", "7.5", false, NaN, Infinity, -1]) {
    assert.equal(model.update({ playbackReadiness: readiness({ delaySeconds }) }).etaSeconds, null);
  }
  assert.equal(model.update({ playbackReadiness: readiness({ delaySeconds: 0 }) }).etaSeconds, 0);
});

test("a full browser buffer does not override a proxy forecast that is not ready", () => {
  const model = new WaitingModel();
  const answer = model.update({
    playbackReadiness: readiness(),
    bufferedAhead: 10
  });

  assert.equal(answer.etaSeconds, 7.5);
  assert.equal(answer.cushionPercent, 100);
  assert.equal(answer.cushionRemainingSeconds, 0);
});

test("shows zero only when the proxy reports playback ready", () => {
  const model = new WaitingModel();
  const answer = model.update({ playbackReadiness: readiness({ ready: true, delaySeconds: 0 }) });

  assert.equal(answer.etaSeconds, 0);
  assert.equal(answer.cushionPercent, 100);
});

test("retains the proxy forecast when only the client buffer changes", () => {
  const model = new WaitingModel();
  model.update({ playbackReadiness: readiness(), bufferedAhead: 2 });
  const answer = model.update({ bufferedAhead: 5 });

  assert.equal(answer.etaSeconds, 7.5);
  assert.equal(answer.cushionPercent, 50);
});

test("reset forgets the previous proxy forecast and client buffer", () => {
  const model = new WaitingModel();
  model.update({ playbackReadiness: readiness(), bufferedAhead: 5 });
  model.reset();
  const answer = model.update({});

  assert.equal(answer.etaSeconds, null);
  assert.equal(answer.cushionPercent, null);
  assert.equal(answer.cushionRemainingSeconds, null);
});
