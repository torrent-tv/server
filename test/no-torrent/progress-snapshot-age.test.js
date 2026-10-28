import assert from "node:assert/strict";
import test from "node:test";

import { progressSnapshotAgeRange, requestSnapshotAgeRange } from "../../public/domain/progress-snapshot-age.js";

test("bounds a proxy snapshot's browser age without assuming symmetric network delay", () => {
  assert.deepEqual(progressSnapshotAgeRange({
    requestStartedAt: 1000,
    responseReceivedAt: 1100,
    requestReceivedAtProxy: 50,
    snapshotAtProxy: 70,
    responsePreparedAtProxy: 80
  }), {
    minimumAgeMs: 10,
    maximumAgeMs: 80,
    measuredAtBrowser: 1100
  });
});

test("rejects impossible or incomplete request timing instead of inventing an age", () => {
  assert.equal(progressSnapshotAgeRange({
    requestStartedAt: 1000,
    responseReceivedAt: 1100,
    requestReceivedAtProxy: 90,
    snapshotAtProxy: 70,
    responsePreparedAtProxy: 80
  }), null);
  assert.equal(progressSnapshotAgeRange({
    requestStartedAt: 1000,
    responseReceivedAt: 1100,
    requestReceivedAtProxy: 50,
    snapshotAtProxy: 70,
    responsePreparedAtProxy: 220
  }), null);
});

test("bounds a worker snapshot to the interval in which its request was read", () => {
  assert.deepEqual(requestSnapshotAgeRange({
    requestStartedAt: 1000,
    responseReceivedAt: 1100,
    requestReceivedAtProxy: 50,
    snapshotStartedAtProxy: 55,
    snapshotCompletedAtProxy: 70,
    responsePreparedAtProxy: 80
  }), {
    minimumAgeMs: 10,
    maximumAgeMs: 95,
    measuredAtBrowser: 1100
  });
});

test("rejects a snapshot interval outside the source response", () => {
  assert.equal(requestSnapshotAgeRange({
    requestStartedAt: 1000,
    responseReceivedAt: 1100,
    requestReceivedAtProxy: 50,
    snapshotStartedAtProxy: 55,
    snapshotCompletedAtProxy: 90,
    responsePreparedAtProxy: 80
  }), null);
});
