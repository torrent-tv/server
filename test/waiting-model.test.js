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

function waitEstimate(overrides = {}) {
  return {
    version: 1,
    waitId: "wait-1",
    revision: 1,
    remainingSeconds: 8,
    ageMs: 0,
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

test("keeps the full wait estimate when readiness reports only a next-segment delay", () => {
  const model = new WaitingModel({ clock: () => 100 });
  assert.equal(model.update({ waitEstimate: waitEstimate() }).etaSeconds, 8);
  assert.equal(model.update({ playbackReadiness: readiness({ delaySeconds: null }) }).etaSeconds, 8);
  assert.equal(model.update({ playbackReadiness: readiness({ delaySeconds: 0.035 }) }).etaSeconds, 8);
});

test("applies measured age once and does not restart a duplicate wait estimate", () => {
  let now = 100;
  const model = new WaitingModel({ clock: () => now });
  const initial = waitEstimate({ remainingSeconds: 8, ageMs: 750 });
  assert.equal(model.update({ waitEstimate: initial }).etaSeconds, 7.25);
  now += 1500;
  assert.equal(model.update({ waitEstimate: { ...initial } }).etaSeconds, 5.75);
});

test("a new wait estimate revision replaces the countdown and invalid measurements are ignored", () => {
  let now = 0;
  const model = new WaitingModel({ clock: () => now });
  model.update({ waitEstimate: waitEstimate({ remainingSeconds: 8 }) });
  now = 1000;
  assert.equal(model.update({ waitEstimate: waitEstimate({ revision: 2, remainingSeconds: 5 }) }).etaSeconds, 5);
  assert.equal(model.update({ waitEstimate: waitEstimate({ revision: 3, remainingSeconds: NaN }) }).etaSeconds, 5);
});

test("an older revision cannot replace a newer estimate", () => {
  let now = 0;
  const model = new WaitingModel({ clock: () => now });
  model.update({ waitEstimate: waitEstimate({ revision: 2, remainingSeconds: 5 }) });
  now = 1000;
  assert.equal(model.update({ waitEstimate: waitEstimate({ revision: 1, remainingSeconds: 30 }) }).etaSeconds, 4);
});

test("an explicit null wait estimate clears the prior action", () => {
  const model = new WaitingModel();
  model.update({ waitEstimate: waitEstimate() });
  assert.equal(model.update({ waitEstimate: null }).etaSeconds, null);
});

test("does not treat the next-segment delay as the full wait and shows the current buffer", () => {
  const model = new WaitingModel();
  const answer = model.update({
    playbackReadiness: readiness(),
    bufferedAhead: 4
  });

  assert.equal(answer.etaSeconds, null);
  assert.equal(answer.cushionPercent, 40);
  assert.equal(answer.cushionRemainingSeconds, 6);
});

test("keeps the total wait unknown when only a local playback delay is available", () => {
  const model = new WaitingModel();
  model.update({ playbackReadiness: readiness() });
  const answer = model.update({
    playbackReadiness: readiness({ delaySeconds: null, reason: "segment-size-unavailable" })
  });

  assert.equal(answer.etaSeconds, null);
  assert.match(formatWaitingText({ etaSeconds: answer.etaSeconds, readinessReason: answer.reason }),
    /Output segment sizes are not available/);
  assert.equal(model.update({ bufferedAhead: 4 }).etaSeconds, null);
});

test("does not expose local readiness delays as the full playback wait", () => {
  const model = new WaitingModel();
  for (const delaySeconds of [undefined, "0", "7.5", false, NaN, Infinity, -1]) {
    assert.equal(model.update({ playbackReadiness: readiness({ delaySeconds }) }).etaSeconds, null);
  }
  const answer = model.update({ playbackReadiness: readiness({ delaySeconds: 0.035, reason: "minimum-safe-delay" }) });
  assert.equal(answer.etaSeconds, null);
  assert.match(formatWaitingText({ etaSeconds: answer.etaSeconds, readinessReason: answer.reason }),
    /Playback readiness has not been confirmed/);
});

test("a full browser buffer does not create a total-wait estimate", () => {
  const model = new WaitingModel();
  const answer = model.update({
    playbackReadiness: readiness(),
    bufferedAhead: 10
  });

  assert.equal(answer.etaSeconds, null);
  assert.equal(answer.cushionPercent, 100);
  assert.equal(answer.cushionRemainingSeconds, 0);
});

test("does not show zero until the first presented frame", () => {
  const model = new WaitingModel();
  const answer = model.update({ playbackReadiness: readiness({ ready: true, delaySeconds: 0 }) });

  assert.equal(answer.etaSeconds, null);
  assert.equal(answer.cushionPercent, 100);
});

test("keeps counting down the full wait after proxy readiness until the estimate expires", () => {
  let now = 0;
  const model = new WaitingModel({ clock: () => now });
  model.update({ waitEstimate: waitEstimate({ remainingSeconds: 0.2 }) });
  now = 100;

  assert.equal(model.update({ playbackReadiness: readiness({ ready: true, delaySeconds: 0 }) }).etaSeconds, 0.1);
  now = 250;
  assert.equal(model.update({}).etaSeconds, null);
});

test("retains the full wait estimate when only the client buffer changes", () => {
  const model = new WaitingModel({ clock: () => 0 });
  model.update({ waitEstimate: waitEstimate({ remainingSeconds: 7.5 }), playbackReadiness: readiness(), bufferedAhead: 2 });
  const answer = model.update({ bufferedAhead: 5 });

  assert.equal(answer.etaSeconds, 7.5);
  assert.equal(answer.cushionPercent, 50);
});

test("counts down the full wait in the local monotonic clock without proxy clock alignment", () => {
  let now = 100;
  const model = new WaitingModel({ clock: () => now });
  assert.equal(model.update({ waitEstimate: waitEstimate({ remainingSeconds: 7.5, ageMs: 0 }) }).etaSeconds, 7.5);
  now += 2500;
  assert.equal(model.update({}).etaSeconds, 5);
  now += 9000;
  assert.equal(model.update({}).etaSeconds, null);
  assert.equal(model.update({ playbackReadiness: readiness({ delaySeconds: 3 }) }).etaSeconds, null);
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

test("rendering the same wait estimate does not postpone its deadline", () => {
  let now = 0;
  const model = new WaitingModel({ clock: () => now });
  const observation = waitEstimate({ remainingSeconds: 4 });
  model.update({ waitEstimate: observation });
  now = 1500;
  assert.equal(model.update({ waitEstimate: observation }).etaSeconds, 2.5);
});

test("a separately parsed duplicate wait estimate does not restart its deadline", () => {
  let now = 0;
  const model = new WaitingModel({ clock: () => now });
  const observation = waitEstimate({ remainingSeconds: 4 });
  model.update({ waitEstimate: observation });
  now = 1500;
  assert.equal(model.update({ waitEstimate: { ...observation } }).etaSeconds, 2.5);
});

test("a new wait-estimate revision starts a new countdown even when its value is unchanged", () => {
  let now = 0;
  const model = new WaitingModel({ clock: () => now });
  model.update({ waitEstimate: waitEstimate({ revision: 1, remainingSeconds: 4 }) });
  now = 1500;
  assert.equal(model.update({ waitEstimate: waitEstimate({ revision: 2, remainingSeconds: 4 }) }).etaSeconds, 4);
});
