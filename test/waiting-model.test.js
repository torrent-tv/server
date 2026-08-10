/**
 * @file The figures the viewer is shown while waiting.
 *
 * This calculation was wrong three times in one day and each time it was
 * invisible: it lived inside a five-thousand-line component that could only be
 * checked by opening a browser and watching. Splitting it out was done so that
 * it could be pinned here — a split that is not tested has bought nothing.
 *
 * Two consumers depend on these answers agreeing: the overlay shows them, and
 * the pre-buffer gate decides when the picture may start from the same numbers.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { WaitingModel } from "../public/domain/waiting-model.js";

/**
 * A proxy progress answer of the shape the poll returns.
 *
 * @param {object} [fields]
 * @returns {object}
 */
function progress(fields = {}) {
  return { state: "running", processedSeconds: 30, startPositionSeconds: 0, speed: "2.0x", ...fields };
}

test("nothing measured yet answers with nulls rather than inventing a figure", () => {
  const model = new WaitingModel();
  const answer = model.update({});
  assert.equal(answer.cushionPercent, null, "no buffer reading means no percentage");
  // Not null: "you still need the whole cushion" is a true statement without a
  // reading, and it is what the gate needs in order to keep waiting.
  assert.equal(answer.cushionRemainingSeconds, model.requiredBufferSeconds());
});

test("a cushion that has reached its target reads 100% with nothing missing", () => {
  const model = new WaitingModel();
  const required = model.requiredBufferSeconds();
  const answer = model.update({ bufferedAhead: required, transcodeProgress: progress() });
  assert.equal(Math.round(answer.cushionPercent), 100);
  assert.equal(answer.cushionRemainingSeconds, 0, "nothing is missing once the target is met");
  assert.equal(answer.etaSeconds, 0, "and zero seconds is the only honest estimate for it");
});

test("an empty buffer needs the whole cushion", () => {
  const model = new WaitingModel();
  const answer = model.update({ bufferedAhead: 0, transcodeProgress: progress() });
  assert.equal(answer.cushionPercent, 0);
  assert.equal(answer.cushionRemainingSeconds, model.requiredBufferSeconds());
});

test("a half-full cushion reads about half", () => {
  const model = new WaitingModel();
  const required = model.requiredBufferSeconds();
  const answer = model.update({ bufferedAhead: required / 2, transcodeProgress: progress() });
  assert.ok(
    Math.abs(answer.cushionPercent - 50) < 1,
    `expected about 50%, got ${answer.cushionPercent}`
  );
});

test("the required cushion is a real number of seconds", () => {
  const required = new WaitingModel().requiredBufferSeconds();
  assert.ok(Number.isFinite(required) && required > 0, `required cushion was ${required}`);
});

test("a buffer past the target does not report more than a full cushion", () => {
  const model = new WaitingModel();
  const answer = model.update({
    bufferedAhead: model.requiredBufferSeconds() * 3,
    transcodeProgress: progress()
  });
  assert.ok(answer.cushionPercent <= 100, `a cushion cannot be ${answer.cushionPercent}% full`);
  assert.equal(answer.cushionRemainingSeconds, 0);
});

test("a failed encode is not described as an encoder run", () => {
  const model = new WaitingModel();
  const answer = model.update({ bufferedAhead: 0, transcodeProgress: progress({ state: "failed" }) });
  assert.deepEqual(
    model.describeEncodingRuns(progress({ state: "failed" }), answer),
    [],
    "a run that has died is not a run the viewer is waiting on"
  );
});

test("nothing being re-encoded is no encoder line at all", () => {
  const model = new WaitingModel();
  const answer = model.update({
    bufferedAhead: 0,
    encodingTracks: { video: false, audio: false },
    transcodeProgress: progress()
  });
  assert.deepEqual(
    model.describeEncodingRuns(progress(), answer),
    [],
    "copied tracks have no encoder to describe"
  );
});

test("an audio-only transcode is described as audio, not as video", () => {
  const model = new WaitingModel();
  const answer = model.update({
    bufferedAhead: 0,
    encodingTracks: { video: false, audio: true },
    transcodeProgress: progress()
  });
  const runs = model.describeEncodingRuns(progress(), answer);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].audio, true);
  assert.notEqual(runs[0].video, true, "audio costs a fraction of a core and video costs whole ones");
});

test("a reset forgets the previous wait", () => {
  const model = new WaitingModel();
  model.update({ bufferedAhead: 0, transcodeProgress: progress() });
  model.reset();
  const answer = model.update({});
  assert.equal(answer.cushionPercent, null, "a new wait starts with nothing measured, not with the old figures");
});

test("the same facts give the same answer to both consumers", () => {
  // The overlay shows these numbers and the pre-buffer gate decides from them.
  // Two instances stand for the two consumers: fed identically they must agree,
  // or the picture starts at a moment the screen never announced.
  const shown = new WaitingModel();
  const gate = new WaitingModel();
  const facts = { bufferedAhead: 4, transcodeProgress: progress() };
  assert.deepEqual(shown.update(facts), gate.update(facts));
});

test("figures survive a fact arriving without the others", () => {
  // Readings come from different places at different rates; one of them being
  // late must not blank the rest.
  const model = new WaitingModel();
  model.update({ bufferedAhead: 5, transcodeProgress: progress() });
  const answer = model.update({ transcodeProgress: progress({ processedSeconds: 40 }) });
  assert.ok(
    Number.isFinite(answer.cushionPercent),
    "the buffer reading from the previous update must still be in force"
  );
});

test("an estimate may rise: nothing floors it at a figure promised earlier", () => {
  const model = new WaitingModel();
  // A first answer, then a wait in which the buffer does not move at all.
  const first = model.update({ bufferedAhead: 1, transcodeProgress: { state: "ready" } });
  assert.ok(first.etaSeconds === null || first.etaSeconds >= 0);
  const later = model.update({ bufferedAhead: 1, transcodeProgress: { state: "ready" } });
  assert.notEqual(
    later.etaSeconds,
    0,
    "a cushion that is still 4s short must never read as no wait at all — " +
    "the floor that produced that was measured on 2026-08-09 saying `fill=4.0@1.00x` and showing zero"
  );
});

test("a reading that arrives alone does not blank what the proxy last said", () => {
  const model = new WaitingModel();
  model.update({
    bufferedAhead: 1,
    downloadStats: { numPeers: 29, downloadSpeed: 13_823_000 },
    transcodeProgress: { state: "ready", processedSeconds: 4208, startPositionSeconds: 4200, speed: "9.01x" }
  });
  // The component that owns the element reads the buffer several times a second
  // and knows nothing about the proxy. Its call used to reset both answers.
  const runs = model.describeEncodingRuns(null, model.update({ bufferedAhead: 2 }));
  assert.ok(Array.isArray(runs), "the model must still know what the proxy said");
  const after = model.update({ bufferedAhead: 2 });
  assert.notEqual(after.cushionPercent, null, "the cushion is still measurable from the retained answer");
});

test("with nothing measured, the estimate rests on the host's median rather than an assumed 1.0x", () => {
  const model = new WaitingModel();
  // A cold open on a host that reports it usually takes 30 s to produce a first
  // segment. Dividing the shortfall by an assumed realtime rate said 4.0s of a
  // wait that ran 46.8s — measured 2026-08-09, median error 21.8s over 164
  // samples, and not one figure borne out.
  const result = model.update({
    bufferedAhead: 0,
    expectedFirstSegmentSeconds: 30,
    transcodeProgress: { state: "ready" }
  });
  assert.ok(
    result.etaSeconds !== null && result.etaSeconds >= 30,
    `an unmeasured wait must not be estimated below what this host is known to take (got ${result.etaSeconds})`
  );
});

test("the cushion the estimate counts down to is the one the gate releases on", () => {
  const model = new WaitingModel();
  // Two figures for one decision is what made the estimate useless at the only
  // moment anyone reads it: the model asked for one segment while the gate held
  // out for fifteen seconds, so it announced "ready, nothing to wait for" and
  // the picture stayed still. Measured 2026-08-09: said=0.0s, was=11.9s.
  assert.equal(
    model.requiredBufferSeconds(),
    15,
    "with no rate measured, both must want the same fallback cushion"
  );
  // A cushion that fills fast needs to be smaller, because the surplus above
  // realtime is what stops it draining.
  model.update({ bufferedAhead: 0, fillRate: 3 });
  const fast = model.requiredBufferSeconds();
  model.update({ bufferedAhead: 0, fillRate: 1.2 });
  const slow = model.requiredBufferSeconds();
  assert.ok(fast < slow, `a faster fill must need less banked (${fast} vs ${slow})`);
  assert.ok(fast >= 6 && slow <= 25, "and both must stay inside the bounds the gate uses");
});

test("the estimate targets the cushion that actually opens the gate", () => {
  const model = new WaitingModel();
  // A healthy, sustained rate: the player starts early, at ten seconds, so an
  // estimate measured against the full target answers a question nobody asked.
  // Measured 2026-08-10: three waits promised 25.0, 20.2 and 24.8 seconds and
  // ended after 7.1, 1.7 and 0.6.
  const healthy = model.update({ bufferedAhead: 0, fillRate: 2.0, transcodeProgress: { state: "ready" } });
  assert.ok(
    healthy.cushionRemainingSeconds <= 10,
    `a healthy link starts early, so at most ten seconds are needed; got ${healthy.cushionRemainingSeconds}`
  );
});

test("a shortfall is divided by the slowest recent rate, not the fastest", () => {
  const model = new WaitingModel();
  model.update({ bufferedAhead: 5, fillRate: 4.0, transcodeProgress: { state: "ready" } });
  const afterCollapse = model.update({ bufferedAhead: 5, fillRate: 0.5, transcodeProgress: { state: "ready" } });
  const optimistic = new WaitingModel();
  const fastOnly = optimistic.update({ bufferedAhead: 5, fillRate: 4.0, transcodeProgress: { state: "ready" } });
  assert.ok(
    afterCollapse.etaSeconds > fastOnly.etaSeconds,
    "a rate that collapsed must lengthen the estimate, not be forgotten in favour of the earlier fast one"
  );
});
