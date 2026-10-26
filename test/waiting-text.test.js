import assert from "node:assert/strict";
import test from "node:test";
import { formatWaitingText, sourceFileIndexesForOperations } from "../public/domain/waiting-text.js";

test("unavailable measurements are identified without an estimating placeholder", () => {
  const text = formatWaitingText({ readinessReason: "encode-rate-unavailable" });
  assert.equal(text.split("\n").length, 3);
  assert.match(text, /This processing configuration has not been measured/);
  assert.doesNotMatch(text, /Estimating/);
});

test("a zero estimate remains visible only as a measured duration", () => {
  assert.equal(formatWaitingText({ etaSeconds: 0 }).split("\n").at(-1), "0 seconds until playback");
});

test("shows supply, configured output paths and total playback time", () => {
  const text = formatWaitingText({ stage: "Preparing playback", peers: 22, seeders: 12,
    downloadBytesPerSecond: 12 * 1024 * 1024, remainingBytes: 15 * 1024 * 1024,
    downloadedBytes: 15 * 1024 * 1024, neededBytes: 30 * 1024 * 1024,
    operations: [{ track: "audio", operation: "encode", inputCodec: "ac3", outputCodec: "aac", speed: 2 }],
    etaSeconds: 38 });
  const rows = text.split("\n");
  assert.equal(rows.length, 3);
  assert.equal(rows[0], "Preparing playback");
  assert.match(rows[1], /peers: 22.*tracker seeders: 12.*12.0 MB\/s.*15.0 MB of 30.0 MB needed.*Audio output path: encode ac3 to aac/);
  assert.doesNotMatch(rows[1], /2\.0x realtime/);
  assert.equal(rows[2], "38.00 seconds until playback");
});

test("an output mode is not described as active work", () => {
  const text = formatWaitingText({ operations: [
    { track: "video", operation: "copy", inputCodec: "h264", speed: 12 },
    { track: "audio", operation: "encode", inputCodec: "ac3", outputCodec: "aac", speed: 2 }
  ] });
  assert.match(text, /Video output path: copy h264/);
  assert.match(text, /Audio output path: encode ac3 to aac/);
  assert.doesNotMatch(text, /Copying|Encoding|12\.0x|2\.0x/);
});

test("source file indexes are unique and unknown scope remains unknown", () => {
  assert.deepEqual(sourceFileIndexesForOperations([
    { sourceFileIndexes: [2, 3] },
    { sourceFileIndexes: [3] }
  ]), [2, 3]);
  assert.equal(sourceFileIndexesForOperations([{ sourceFileIndexes: [2] }, {}]), null);
  assert.equal(sourceFileIndexesForOperations([{ sourceFileIndexes: [] }]), null);
});

test("formats wait estimates with precision that keeps display rounding within five percent", () => {
  const lastLine = (etaSeconds) => formatWaitingText({ etaSeconds }).split("\n").at(-1);
  assert.equal(lastLine(0.19), "0.190 seconds until playback");
  assert.equal(lastLine(1.05), "1.05 seconds until playback");
  assert.equal(lastLine(6.02), "6.02 seconds until playback");
  assert.equal(lastLine(10.5), "10.50 seconds until playback");
});

test("a proxy without the readiness forecast is identified", () => {
  assert.match(
    formatWaitingText({ readinessUnavailable: true }),
    /This proxy needs an update before playback can start/
  );
});

test("unresolved source byte ranges are not described as unknown media positions", () => {
  assert.match(formatWaitingText({ readinessReason: "source-input-ranges-unavailable" }),
    /source byte ranges needed by upcoming segments are not available yet/);
  assert.doesNotMatch(formatWaitingText({ readinessReason: "source-input-ranges-unavailable" }),
    /media positions have not been determined/);
  assert.match(formatWaitingText({ readinessReason: "download-schedule-unavailable" }),
    /Arrival times for required source data are not available/);
});

test("a start the proxy cannot hold on its disk says why it goes on waiting", () => {
  const text = formatWaitingText({ readinessReason: "cushion-exceeds-storage" });
  assert.match(text, /downloads slower than it plays/);
  assert.doesNotMatch(text, /until playback/);
});
