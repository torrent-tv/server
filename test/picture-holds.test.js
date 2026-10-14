import test from "node:test";
import assert from "node:assert/strict";
import { PictureHolds, nextSeekHoldAsk, seekHoldAnswer } from "../public/domain/picture-holds.js";

// Which change holds the picture, and when a seek's hold may end
// (torrent-tv/meta#178).

function recorder() {
  const signals = [];
  const holds = new PictureHolds({ held: () => signals.push("held"), released: () => signals.push("released") });
  return { holds, signals };
}

test("the picture moves again only when no change holds it", () => {
  const { holds, signals } = recorder();
  holds.take("audio");
  const seek = holds.beginSeek();
  holds.releaseSeek(seek);
  assert.deepEqual(signals, ["held", "held"], "a seek ending does not release the soundtrack being prepared");
  holds.release("audio");
  assert.deepEqual(signals, ["held", "held", "released"]);
  assert.equal(holds.held, false);
});

test("a later seek takes the hold over, and the earlier seek's answer releases nothing", () => {
  const { holds, signals } = recorder();
  const first = holds.beginSeek();
  const second = holds.beginSeek();
  assert.equal(holds.holdsSeek(first), false);
  assert.equal(holds.holdsSeek(second), true);
  holds.releaseSeek(first);
  assert.deepEqual(signals, ["held", "held"], "the late answer of the first seek leaves the picture held");
  holds.releaseSeek(second);
  assert.deepEqual(signals, ["held", "held", "released"]);
});

test("releasing what is not held changes nothing", () => {
  const { holds, signals } = recorder();
  holds.release("audio");
  holds.releaseSeek(7);
  assert.deepEqual(signals, []);
});

test("a seek's hold ends on the proxy's forecast for the position it was told of", () => {
  const ready = { version: 1, ready: true };
  const waiting = { version: 1, ready: false, reason: "minimum-safe-delay" };
  assert.equal(seekHoldAnswer({ readiness: ready, requestedAt: 5, reportedAt: 10 }), "stale",
    "asked before the seek was reported: may describe the old position");
  assert.equal(seekHoldAnswer({ readiness: waiting, requestedAt: 10, reportedAt: 10 }), "wait");
  assert.equal(seekHoldAnswer({ readiness: ready, requestedAt: 11, reportedAt: 10 }), "release");
  assert.equal(seekHoldAnswer({ readiness: null, requestedAt: 11, reportedAt: 10 }), "release",
    "a proxy that states no forecast releases the hold, as before");
  assert.equal(seekHoldAnswer({ readiness: { version: 1, ready: false, bufferLimitReached: true }, requestedAt: 11, reportedAt: 10 }), "wait",
    "a full browser buffer is not a reason to start (review)");
});

test("the hold asks again when the forecast says the position may be ready, or at the cadence", () => {
  assert.equal(nextSeekHoldAsk({ delaySeconds: 0.15 }, 1500), 150, "a short delay is not waited out a whole cadence");
  assert.equal(nextSeekHoldAsk({ delaySeconds: 7.18 }, 1500), 1500, "a long one is asked about at the cadence, which may bring it nearer");
  assert.equal(nextSeekHoldAsk({ delaySeconds: 0 }, 1500), 1500, "no delay stated in the future is no reason to ask at once");
  assert.equal(nextSeekHoldAsk({}, 1500), 1500);
  assert.equal(nextSeekHoldAsk(null, 1500), 1500);
});
