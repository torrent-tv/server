import assert from "node:assert/strict";
import test from "node:test";

import { browserCaptureAgeRange, progressSnapshotAgeRange, proxyInputAgeRange,
  requestSnapshotAgeRange } from "../../public/domain/progress-snapshot-age.js";

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

test("bounds an older proxy input through this request without assuming half an RTT", () => {
  assert.deepEqual(proxyInputAgeRange({
    requestStartedAt: 1000,
    responseReceivedAt: 1100,
    requestReceivedAtProxy: 50,
    responsePreparedAtProxy: 80,
    requestClockEpoch: 7,
    captureClockEpoch: 7,
    captureStartedAt: 40,
    captureCompletedAt: 45
  }), {
    minimumAgeMs: 35,
    maximumAgeMs: 110,
    measuredAtBrowser: 1100
  });
});

test("rejects proxy input marks from an old clock epoch or after response preparation", () => {
  const request = { requestStartedAt: 1000, responseReceivedAt: 1100, requestReceivedAtProxy: 50,
    responsePreparedAtProxy: 80, requestClockEpoch: 7, captureStartedAt: 55, captureCompletedAt: 70 };
  assert.equal(proxyInputAgeRange({ ...request, captureClockEpoch: 6 }), null);
  assert.equal(proxyInputAgeRange({ ...request, captureClockEpoch: 7, captureCompletedAt: 90 }), null);
});

test("bounds browser-owned input on its own clock and rejects an old page epoch", () => {
  const input = { requestStartedAt: 1000, responseReceivedAt: 1100, clockEpoch: 7,
    captureClockEpoch: 7, captureStartedAt: 900, captureCompletedAt: 950 };
  assert.deepEqual(browserCaptureAgeRange(input), {
    minimumAgeMs: 150,
    maximumAgeMs: 200,
    measuredAtBrowser: 1100
  });
  assert.equal(browserCaptureAgeRange({ ...input, captureClockEpoch: 6 }), null);
  assert.equal(browserCaptureAgeRange({ ...input, captureCompletedAt: 899 }), null);
  assert.equal(browserCaptureAgeRange({ ...input, captureCompletedAt: 1101 }), null);
});
