/**
 * @file How big an ask has to be to measure a link.
 *
 * Derived, never chosen: an ask too quick to time says how many bytes that same
 * rate needs to fill the minimum measurable time, and the ceiling is the
 * fastest link any decision this product makes can distinguish.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  FIRST_PROBE_BYTES,
  MAX_PROBE_BYTES,
  nextProbeBytes
} from "../public/domain/transport/link-probe.js";

test("the first ask is one message on the wire", () => {
  assert.equal(FIRST_PROBE_BYTES, 65536);
});

test("an ask too quick to time grows to what that rate needs to fill the minimum", () => {
  // 65536 bytes in 5 ms; fifty milliseconds of the same rate is ten times as
  // many bytes, and that is what is asked for next.
  assert.equal(
    nextProbeBytes({ lastBytes: 65536, lastMs: 5, measurableSoFar: 0, minSampleMs: 50 }),
    655360
  );
});

test("an ask that registered no time at all still grows, and by a bounded step", () => {
  const next = nextProbeBytes({
    lastBytes: 65536,
    lastMs: 0,
    measurableSoFar: 0,
    minSampleMs: 50
  });
  // A transfer of no measured duration is read as one millisecond, so the step
  // is fifty times — and the ceiling is what stops it.
  assert.equal(next, Math.min(MAX_PROBE_BYTES, 65536 * 50));
});

test("an ask that was measurable is repeated until there are enough readings", () => {
  assert.equal(
    nextProbeBytes({ lastBytes: 524288, lastMs: 80, measurableSoFar: 1, minSampleMs: 50 }),
    524288
  );
  assert.equal(
    nextProbeBytes({ lastBytes: 524288, lastMs: 80, measurableSoFar: 2, minSampleMs: 50 }),
    null
  );
});

test("a link too fast to time at the ceiling is left unmeasured rather than fed more", () => {
  assert.equal(
    nextProbeBytes({ lastBytes: MAX_PROBE_BYTES, lastMs: 2, measurableSoFar: 0, minSampleMs: 50 }),
    null
  );
});

test("a slow link is measured by the first ask and costs nothing more", () => {
  // 65536 bytes in 200 ms is 2.6 Mbit/s. It is measurable at once, so the size
  // never grows: a thin link pays 64 KiB twice and no more.
  const second = nextProbeBytes({
    lastBytes: FIRST_PROBE_BYTES,
    lastMs: 200,
    measurableSoFar: 1,
    minSampleMs: 50
  });
  assert.equal(second, FIRST_PROBE_BYTES);
  assert.equal(
    nextProbeBytes({
      lastBytes: FIRST_PROBE_BYTES,
      lastMs: 200,
      measurableSoFar: 2,
      minSampleMs: 50
    }),
    null
  );
});
