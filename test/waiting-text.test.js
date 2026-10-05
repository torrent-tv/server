import assert from "node:assert/strict";
import test from "node:test";
import { formatWaitingText } from "../public/domain/waiting-text.js";

test("unavailable measurements are identified without an estimating placeholder", () => {
  const text = formatWaitingText({ readinessReason: "encode-rate-unavailable" });
  assert.equal(text.split("\n").length, 3);
  assert.match(text, /This processing configuration has not been measured/);
  assert.doesNotMatch(text, /Estimating/);
});

test("a zero estimate remains visible only as a measured duration", () => {
  assert.equal(formatWaitingText({ etaSeconds: 0 }).split("\n").at(-1), "0 seconds until playback");
});

test("shows download and processing facts in one details row and total playback time", () => {
  const text = formatWaitingText({ stage: "Encoding", peers: 22, seeders: 12,
    downloadBytesPerSecond: 12 * 1024 * 1024, remainingBytes: 15 * 1024 * 1024,
    downloadedBytes: 15 * 1024 * 1024, neededBytes: 30 * 1024 * 1024,
    operations: [{ track: "audio", operation: "encode", inputCodec: "ac3", outputCodec: "aac", speed: 2 }],
    etaSeconds: 38 });
  const rows = text.split("\n");
  assert.equal(rows.length, 3);
  assert.equal(rows[0], "Encoding");
  assert.match(rows[1], /peers: 22.*tracker seeders: 12.*12.0 MB\/s.*15.0 MB of 30.0 MB needed.*ac3 to aac/);
  assert.equal(rows[2], "38 seconds until playback");
});

test("a proxy without the readiness forecast is identified", () => {
  assert.match(
    formatWaitingText({ readinessUnavailable: true }),
    /This proxy needs an update before playback can start/
  );
});

test("unknown media positions and unknown arrivals remain distinct waiting causes", () => {
  assert.match(formatWaitingText({ readinessReason: "source-input-ranges-unavailable" }),
    /required media positions have not been determined/);
  assert.match(formatWaitingText({ readinessReason: "download-schedule-unavailable" }),
    /Arrival times for required source data are not available/);
});
