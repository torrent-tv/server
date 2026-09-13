/**
 * @file The wedge verdict, checked with plain values only.
 *
 * No browser, no channel, no clock — which is the point of putting the decision
 * in a pure function. Every case here is either a shape the field produced or a
 * shape that must NOT be called a wedge.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { wedgeVerdict } from "../public/domain/transport/wedge-verdict.js";

const TIMEOUT = 60_000;

test("silence longer than a request's own bound, with requests waiting, is a wedge", () => {
  const verdict = wedgeVerdict({
    silentMs: 63_000,
    pendingRequests: 5,
    requestTimeoutMs: TIMEOUT,
    channelOpen: true
  });
  assert.equal(verdict.wedged, true);
  // The field shape of 2026-09-12: five requests waiting, nothing delivered.
  assert.match(verdict.reason, /5 request\(s\) waiting/);
});

test("silence inside the bound is not a wedge, however long it feels", () => {
  const verdict = wedgeVerdict({
    silentMs: 59_999,
    pendingRequests: 3,
    requestTimeoutMs: TIMEOUT,
    channelOpen: true
  });
  assert.equal(verdict.wedged, false);
  assert.match(verdict.reason, /59999ms of the 60000ms/);
});

test("exactly at the bound is a wedge — the request is dead at that moment", () => {
  assert.equal(
    wedgeVerdict({ silentMs: TIMEOUT, pendingRequests: 1, requestTimeoutMs: TIMEOUT, channelOpen: true }).wedged,
    true
  );
});

test("silence with nothing outstanding is not a wedge", () => {
  // A viewer holding two minutes of cushion stops fetching. Every wedge verdict
  // that ever fired falsely in this product fired in a quiet moment like this.
  const verdict = wedgeVerdict({
    silentMs: 600_000,
    pendingRequests: 0,
    requestTimeoutMs: TIMEOUT,
    channelOpen: true
  });
  assert.equal(verdict.wedged, false);
  assert.match(verdict.reason, /nobody asked/);
});

test("a closed channel is an ordinary loss, not a wedge", () => {
  // The reconnect ladder already handles this one, and it works: field
  // 2026-09-12 20:03. Calling it a wedge would double-report the same loss.
  const verdict = wedgeVerdict({
    silentMs: 600_000,
    pendingRequests: 4,
    requestTimeoutMs: TIMEOUT,
    channelOpen: false
  });
  assert.equal(verdict.wedged, false);
  assert.match(verdict.reason, /closed/);
});

test("no request bound means nothing to judge against", () => {
  assert.equal(
    wedgeVerdict({ silentMs: 600_000, pendingRequests: 4, requestTimeoutMs: 0, channelOpen: true }).wedged,
    false
  );
});

test("the verdict holds no state: the same facts give the same answer", () => {
  const facts = { silentMs: 90_000, pendingRequests: 2, requestTimeoutMs: TIMEOUT, channelOpen: true };
  const first = wedgeVerdict(facts);
  const second = wedgeVerdict(facts);
  assert.deepEqual(first, second);
  assert.equal(first.wedged, true);
});
