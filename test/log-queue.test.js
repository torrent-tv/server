import assert from "node:assert/strict";
import test from "node:test";

import { LogQueue, MAX_BATCH_BYTES, MAX_BATCH_LINES, utf8Bytes } from "../public/shared/log-queue.js";

/**
 * The body the page sends, with the fields `client-logger.js` puts around the
 * lines, so the byte limit is checked against a frame of the real shape.
 *
 * @param {object[]} lines
 * @param {number} seq
 * @returns {string}
 */
function frame(lines, seq) {
  return JSON.stringify({
    sessionId: "e15ec249", tag: "Windows/Chrome", userAgent: "Mozilla/5.0 (Windows NT 10.0) Chrome/155",
    signalSessionId: "1995bfc5-fc7d-46da-9f39-4da8ec1a17e0", seq, lines,
    startedAt: "2026-10-05T12:00:00.000Z", torrentName: "", infoHash: ""
  });
}

/**
 * @param {number} index
 * @param {number} [length]
 * @returns {{ level: string, ts: string, msg: string }}
 */
function line(index, length = 20) {
  return { level: "debug", ts: "12:00:00.000", msg: `${index}:`.padEnd(length, "я") };
}

/** @returns {LogQueue} */
function queueOf(capacity = 500) {
  return new LogQueue({ capacity, frame, now: () => "12:00:00.000" });
}

test("a batch of the longest lines stays inside the 64 KiB a keepalive request may carry", () => {
  const queue = queueOf();
  // 2000 characters, the per-line cap, of a two-byte script: 4 KB each, so
  // fifty of them are 200 KB and the old batch was three times the limit.
  for (let index = 0; index < MAX_BATCH_LINES; index++) {
    queue.push(line(index, 2000));
  }
  const batch = queue.take();
  assert.ok(batch);
  assert.equal(batch.bytes, utf8Bytes(batch.body), "the size is counted exactly, not estimated");
  assert.ok(batch.bytes <= MAX_BATCH_BYTES, `${batch.bytes} bytes`);
  assert.ok(batch.lines.length < MAX_BATCH_LINES);
  // Nothing is lost by splitting: the rest leaves in the following batches.
  let taken = batch.lines.length;
  for (let next = queue.take(); next; next = queue.take()) {
    assert.ok(next.bytes <= MAX_BATCH_BYTES);
    taken += next.lines.length;
  }
  assert.equal(taken, MAX_BATCH_LINES);
});

test("a batch carries no more lines than the receivers keep", () => {
  const queue = queueOf();
  for (let index = 0; index < 120; index++) {
    queue.push(line(index));
  }
  const sizes = [];
  for (let batch = queue.take(); batch; batch = queue.take()) {
    sizes.push(batch.lines.length);
  }
  assert.deepEqual(sizes, [50, 50, 20]);
});

test("a batch nobody took comes back to the front, in order, and leaves with the next send", () => {
  const queue = queueOf();
  for (let index = 0; index < 3; index++) {
    queue.push(line(index));
  }
  const failed = queue.take();
  assert.ok(failed);
  queue.push(line(3));
  queue.noteFailure("server", new TypeError("Failed to fetch"));
  queue.giveBack(failed);
  const again = queue.take();
  assert.ok(again);
  assert.deepEqual(again.lines.map((entry) => entry.msg.split(":")[0]), ["0", "1", "2", "3"]);
  assert.notEqual(again.seq, failed.seq, "each send has its own number");
});

test("what was lost and why is written into the log and goes out with the next batch", () => {
  const queue = queueOf(4);
  for (let index = 0; index < 6; index++) {
    queue.push(line(index));
  }
  queue.noteFailure("proxy", new Error("Data channel request timed out."));
  queue.noteFailure("proxy", new Error("Data channel request timed out."));
  queue.noteFailure("server", new TypeError("Failed to fetch"));
  queue.reportLosses();
  const batch = queue.take();
  assert.ok(batch);
  const report = batch.lines[0];
  assert.equal(report.level, "warn");
  assert.match(report.msg, /^\[client-logger\] since 12:00:00\.000: /);
  // Two pushed out by the limit of four, and one more to make room for the report.
  assert.match(report.msg, /3 line\(s\) pushed out by the 4-line limit and lost/);
  assert.match(report.msg, /proxy: Error: Data channel request timed out\. ×2/);
  assert.match(report.msg, /server: TypeError: Failed to fetch ×1/);
  assert.deepEqual(batch.lines.slice(1).map((entry) => entry.msg.split(":")[0]), ["3", "4", "5"]);
});

test("nothing is reported when nothing was lost", () => {
  const queue = queueOf();
  queue.push(line(0));
  queue.reportLosses();
  assert.equal(queue.take()?.lines.length, 1);
});

test("while a report is undelivered no second one is written; the counts wait for the next", () => {
  const queue = queueOf();
  queue.push(line(0));
  queue.noteFailure("server", "HTTP 502");
  queue.reportLosses();
  for (let attempt = 0; attempt < 5; attempt++) {
    const batch = queue.take();
    assert.ok(batch);
    queue.noteFailure("server", "HTTP 502");
    queue.giveBack(batch);
    queue.reportLosses();
  }
  const batch = queue.take();
  assert.ok(batch);
  assert.equal(batch.lines.filter((entry) => entry.msg.startsWith("[client-logger]")).length, 1);
  queue.delivered(batch);
  queue.reportLosses();
  const next = queue.take();
  assert.ok(next);
  assert.match(next.lines[0].msg, /server: HTTP 502 ×5/);
});
