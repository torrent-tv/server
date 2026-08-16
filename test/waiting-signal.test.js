/**
 * @file The rule that decides whether a wait is shown to the viewer.
 *
 * Written against the two field cases it exists to separate: an audio track
 * changed on 2026-08-15 (the picture kept running for 2.75 s while the new
 * track was produced) and a stall (the picture stops). The rule it replaced was
 * a four-second amnesty after a track change, which hid a stall beginning
 * inside those seconds — permanently, since `waiting` fires on a transition and
 * an element already waiting never fires it again.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { shouldReportWaiting } from "../public/domain/waiting-signal.js";

const at = (positionSeconds, { seeking = false, readyState = 2 } = {}) => ({
  positionSeconds,
  seeking,
  readyState
});

test("a picture that kept running is not reported — the audio track is being changed", () => {
  assert.equal(shouldReportWaiting(at(120.0), at(120.4)), false);
});

test("a picture that stopped is reported, however it came to stop", () => {
  assert.equal(shouldReportWaiting(at(120.0), at(120.0)), true);
});

test("a stall that begins moments after a track change is still reported", () => {
  // The case the amnesty hid: the switch happens, and while the new track is
  // being produced the transport dies. The picture stops, and that is all this
  // rule needs to know — it has no memory of the switch at all.
  assert.equal(shouldReportWaiting(at(120.0), at(120.005)), true);
});

test("a seek is always reported, even though its position jumped forward", () => {
  // `seeking` stays true until the target data arrives. Judged by movement
  // alone this would read as a running picture, because the position leapt.
  assert.equal(shouldReportWaiting(at(120.0), at(600.0, { seeking: true })), true);
});

test("an element with enough buffered to continue is not reported", () => {
  assert.equal(shouldReportWaiting(at(120.0), at(120.0, { readyState: 4 })), false);
});

test("movement below a frame is not movement", () => {
  assert.equal(shouldReportWaiting(at(120.0), at(120.01)), true);
});
