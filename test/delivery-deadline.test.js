/**
 * @file The delivery deadline and the meaning of a silence, with plain values.
 *
 * Every case is a shape from the field (meta
 * research/stalled-channel-recovery-2026-10-04.md) or a shape that must NOT be
 * called a stall.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  deliveryDueWithinMs,
  emptyArrivalEstimate,
  noteProbeGap,
  silenceVerdict
} from "../public/domain/transport/delivery-deadline.js";

const TIMEOUT = 60_000;

/** Probes every 500 ms with the few milliseconds of jitter a healthy link shows. */
function steady(count = 40) {
  let estimate = emptyArrivalEstimate();
  for (let index = 0; index < count; index += 1) {
    estimate = noteProbeGap(estimate, 500 + (index % 3) * 10);
  }
  return estimate;
}

const healthy = {
  outstanding: 3,
  channelOpen: true,
  messagesWaiting: false,
  stalledAlready: false,
  requestTimeoutMs: TIMEOUT
};

test("nothing can be said before one gap between probes has been measured", () => {
  assert.equal(deliveryDueWithinMs(emptyArrivalEstimate()), null);
  const verdict = silenceVerdict({ ...healthy, silentMs: 30_000, dueWithinMs: null });
  assert.equal(verdict.state, "cannot-judge");
});

test("a steady rhythm of half-second probes makes the next delivery due within about half a second", () => {
  const due = deliveryDueWithinMs(steady());
  assert.ok(due > 500 && due < 600, `due within ${due} ms`);
});

test("the 2026-09-28 wedge is a stall within a second, not after sixty", () => {
  // Probe 1464 at 20:41:31, then nothing; 39 requests were waiting by the end.
  const due = deliveryDueWithinMs(steady());
  const verdict = silenceVerdict({ ...healthy, silentMs: 1_000, dueWithinMs: due });
  assert.equal(verdict.state, "stalled");
});

test("silence with nobody waiting is not a stall", () => {
  const verdict = silenceVerdict({ ...healthy, outstanding: 0, silentMs: 30_000, dueWithinMs: 540 });
  assert.equal(verdict.state, "delivering");
});

test("messages received and not yet handled are deliveries, however late the check runs", () => {
  // A hidden tab's timer fires late; by then the transport may hold messages
  // the page has not handled yet.
  const verdict = silenceVerdict({ ...healthy, silentMs: 5_000, dueWithinMs: 540, messagesWaiting: true });
  assert.equal(verdict.state, "delivering");
});

test("a closed channel is somebody else's business", () => {
  const verdict = silenceVerdict({ ...healthy, channelOpen: false, silentMs: 90_000, dueWithinMs: 540 });
  assert.equal(verdict.state, "cannot-judge");
});

test("a stall that lasts a whole request bound is lost, whether or not anyone is still waiting", () => {
  // Every request that was waiting has timed out by then.
  const verdict = silenceVerdict({
    ...healthy,
    outstanding: 0,
    stalledAlready: true,
    silentMs: TIMEOUT,
    dueWithinMs: 540
  });
  assert.equal(verdict.state, "lost");
  const notYet = silenceVerdict({ ...healthy, outstanding: 0, stalledAlready: true, silentMs: TIMEOUT - 1, dueWithinMs: 540 });
  assert.equal(notYet.state, "stalled");
});

test("one 21 s gap lengthens the deadline for a measured while and then lets go", () => {
  // The proxy's main thread blocked for 21 s on 2026-10-01; probes stopped and
  // then resumed every half second.
  let estimate = noteProbeGap(steady(), 21_000);
  const right = deliveryDueWithinMs(estimate);
  assert.ok(right > 20_000, `right after: ${right}`);
  const dueAfter = {};
  for (let probes = 1; probes <= 30; probes += 1) {
    estimate = noteProbeGap(estimate, 500);
    dueAfter[probes] = deliveryDueWithinMs(estimate);
  }
  assert.ok(dueAfter[6] < right / 2, `half after six probes: ${dueAfter[6]}`);
  assert.ok(dueAfter[24] < 1_500, `under 1.5 s after twenty-four probes: ${dueAfter[24]}`);
  assert.ok(dueAfter[30] < 1_000, `under a second after thirty probes: ${dueAfter[30]}`);
});

test("a gap that is not a number leaves the estimate alone", () => {
  const before = steady();
  assert.deepEqual(noteProbeGap(before, Number.NaN), before);
  assert.deepEqual(noteProbeGap(before, -5), before);
});
