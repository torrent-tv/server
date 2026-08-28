/**
 * @file How deep a cushion the player is allowed to hold.
 *
 * The proxy keeps two minutes of video produced ahead of the viewer and the
 * player used to hold thirty seconds of it, on a ceiling of sixty justified in
 * a comment by `MAX_LOOKAHEAD_SEGMENTS × 4 s ≈ 32 s` — a figure that bounds a
 * request ahead of the ENCODE HEAD and says nothing about how much a player may
 * hold ahead of the VIEWER. The proxy now states what it keeps, and the ceiling
 * is that. Roadmap item 4, step 2.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { bufferByteBudget, forwardBufferCeilingSeconds } from "../public/domain/hls-player.js";

// What the player carried before any proxy told it otherwise. An older proxy
// must go on behaving exactly as it did.
const WITHOUT_A_FIGURE = 60;

test("the proxy's stated look-ahead becomes the ceiling", () => {
  assert.equal(forwardBufferCeilingSeconds(120), 120);
});

test("a proxy that states nothing leaves the ceiling where it was", () => {
  assert.equal(forwardBufferCeilingSeconds(undefined), WITHOUT_A_FIGURE);
  assert.equal(forwardBufferCeilingSeconds(null), WITHOUT_A_FIGURE);
  assert.equal(forwardBufferCeilingSeconds(0), WITHOUT_A_FIGURE);
  assert.equal(forwardBufferCeilingSeconds(""), WITHOUT_A_FIGURE);
});

test("nothing that is not a number can lower the cushion", () => {
  assert.equal(forwardBufferCeilingSeconds("soon"), WITHOUT_A_FIGURE);
  assert.equal(forwardBufferCeilingSeconds(Number.NaN), WITHOUT_A_FIGURE);
  assert.equal(forwardBufferCeilingSeconds(Number.POSITIVE_INFINITY), WITHOUT_A_FIGURE);
  assert.equal(forwardBufferCeilingSeconds(-30), WITHOUT_A_FIGURE);
});

test("a proxy holding LESS than this player would does not shrink the cushion", () => {
  // A shorter look-ahead is a statement about the encoder, not about what the
  // player may hold: everything already produced is still on the proxy's disk
  // and served without a wait. Lowering the ceiling below what the player
  // managed before would take away a cushion nothing has shown to be harmful.
  assert.equal(forwardBufferCeilingSeconds(20), WITHOUT_A_FIGURE);
});

test("the byte budget buys exactly the ceiling at the level's own bitrate", () => {
  // 120 s of 8 Mbit/s is 120 MB. hls.js then computes
  // 8 × 120e6 / 8e6 = 120 s — the ceiling, reached rather than truncated.
  assert.equal(bufferByteBudget(120, 8e6), 120e6);
  assert.equal((8 * bufferByteBudget(120, 8e6)) / 8e6, 120);
  // And at a bitrate where the default 60 MB used to cut the cushion to 19 s.
  assert.equal((8 * bufferByteBudget(120, 25e6)) / 25e6, 120);
});

test("a thin level keeps hls.js's own default rather than being cut down", () => {
  // 120 s of 1 Mbit/s is 15 MB, but the ceiling already binds there: the byte
  // term buys 480 s and the smaller of the two decides. Lowering the budget
  // would gain nothing and take away the cushion the player managed before.
  assert.equal(bufferByteBudget(120, 1e6), 60 * 1000 * 1000);
});

test("an unstated bitrate leaves hls.js's own default in place", () => {
  assert.equal(bufferByteBudget(120, 0), 60 * 1000 * 1000);
  assert.equal(bufferByteBudget(120, undefined), 60 * 1000 * 1000);
  assert.equal(bufferByteBudget(0, 8e6), 60 * 1000 * 1000);
  assert.equal(bufferByteBudget(120, Number.NaN), 60 * 1000 * 1000);
});
