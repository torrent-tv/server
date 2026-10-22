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
import {
  askedForwardBufferSeconds,
  bufferByteBudget,
  ceilingAfterUnaskedRemoval,
  ceilingWhilePlayedMediaIsEvicted,
  ceilingWorthRetrying,
  forwardBufferCeilingSeconds
} from "../public/domain/hls-player.js";

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

test("the depth asked for is hls.js's own arithmetic, not the field we set", () => {
  // What `getMaxBufferLength` does: the larger of the floor and what the byte
  // budget buys at this level's bitrate, capped by the ceiling. A reading that
  // printed `maxMaxBufferLength` instead would say 120 s on a session holding
  // 30, which is the blindness this figure exists to remove.
  const config = { maxBufferLength: 30, maxMaxBufferLength: 120, maxBufferSize: 60e6 };

  assert.equal(
    askedForwardBufferSeconds(config, 8e6),
    60,
    "60 MB buys 60 s at 8 Mbit/s — below the ceiling, so the bytes decide"
  );
  assert.equal(
    askedForwardBufferSeconds(config, 25e6),
    30,
    "60 MB buys 19.2 s at 25 Mbit/s, and the floor is what saves it"
  );
  assert.equal(
    askedForwardBufferSeconds({ ...config, maxBufferSize: 120e6 }, 8e6),
    120,
    "sized to the ceiling at this bitrate, the ceiling is what is reached"
  );
  assert.equal(
    askedForwardBufferSeconds({ ...config, maxBufferSize: 400e6 }, 8e6),
    120,
    "and the ceiling still caps a budget larger than it"
  );
});

test("a level with no stated bitrate falls back to the floor", () => {
  // Nothing to divide by: hls.js answers `maxBufferLength` alone, and so must
  // the reading, or it would claim a depth taken from a bitrate of zero.
  assert.equal(
    askedForwardBufferSeconds({ maxBufferLength: 30, maxMaxBufferLength: 120, maxBufferSize: 60e6 }, 0),
    30
  );
});

/**
 * A refusal to buffer deeper is re-tested, because the first one is always
 * taken at the worst possible moment.
 *
 * A media element may only evict frames the playhead has PASSED. Two minutes
 * into a film there are none, so `QuotaExceededError` is certain whatever the
 * device could hold — and hls.js only ever divides its ceiling, never raises
 * it. Field 2026-08-31: 120 s → 73 s at 15:11:12 of a session that ran to
 * 16:24, and the remaining 73 minutes held two thirds of what the proxy had
 * ready for them.
 */
const REFUSED = { ceiling: 73, statedCeiling: 120, behindSeconds: 300, msSinceRefusal: 120_000, attempts: 0 };

test("a refusal is tried again once there is something to evict, halfway back", () => {
  assert.equal(ceilingWorthRetrying(REFUSED), 97, "halfway from 73 to 120");
});

test("nothing behind the playhead means the refusal would be certain again", () => {
  // The condition that caused it has not changed, so asking again only earns a
  // second refusal and another halving.
  assert.equal(ceilingWorthRetrying({ ...REFUSED, behindSeconds: 20 }), 0);
  assert.equal(ceilingWorthRetrying({ ...REFUSED, behindSeconds: 72.9 }), 0);
  assert.equal(ceilingWorthRetrying({ ...REFUSED, behindSeconds: 73 }), 97, "as much behind as it wants ahead");
});

test("a device at its real limit is left alone after a few rounds", () => {
  assert.equal(ceilingWorthRetrying({ ...REFUSED, attempts: 2 }), 97);
  assert.equal(ceilingWorthRetrying({ ...REFUSED, attempts: 3 }), 0);
});

test("a refusal is not argued with immediately", () => {
  assert.equal(ceilingWorthRetrying({ ...REFUSED, msSinceRefusal: 59_000 }), 0);
  assert.equal(ceilingWorthRetrying({ ...REFUSED, msSinceRefusal: 0 }), 0, "no refusal recorded yet");
});

test("a ceiling already at what the proxy holds is not raised past it", () => {
  assert.equal(ceilingWorthRetrying({ ...REFUSED, ceiling: 120 }), 0);
  assert.equal(ceilingWorthRetrying({ ...REFUSED, ceiling: 119.5 }), 0, "half a second is not worth a round");
  // Halving the remaining distance means the steps get smaller, and a step of
  // about a second buys nothing while costing a round of the three there are.
  assert.equal(ceilingWorthRetrying({ ...REFUSED, ceiling: 118 }), 0, "one second is not a step");
  assert.equal(ceilingWorthRetrying({ ...REFUSED, ceiling: 115 }), 118);
});

test("the steps converge and stop, without ever passing what the proxy holds", () => {
  // The whole of a session that began with the field's own refusal.
  const seen = [];
  let ceiling = 73;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const next = ceilingWorthRetrying({ ...REFUSED, ceiling, attempts: attempt });
    if (next === 0) {
      break;
    }
    seen.push(next);
    ceiling = next;
  }
  assert.deepEqual(seen, [97, 109, 115], "three attempts, each halving what is left");
  assert.ok(seen.every((value) => value <= 120), "and never past what the proxy holds ahead");
});

test("no ceiling and no stated depth means nothing to do", () => {
  assert.equal(ceilingWorthRetrying({ ...REFUSED, ceiling: 0 }), 0);
  assert.equal(ceilingWorthRetrying({ ...REFUSED, statedCeiling: 0 }), 0);
});

/**
 * A removal for room that nobody asked for is the device refusing the depth.
 *
 * hls.js 1.7 answers `QuotaExceededError` by removing played media itself and
 * says nothing while that works. Its removal ends at a fragment's end, and the
 * browser extends it to the next keyframe, which with the played media used up
 * lies ahead of the playhead: field 2026-10-22, the picture at 509.2 s lost the
 * frames to 510.135 s and never moved again (torrent-tv/meta#231). The answer
 * is hls.js's own to a refusal it reports, `reduceMaxBufferLength`.
 */
const FULL = { ceiling: 120, heldAheadSeconds: 120, fragmentSeconds: 6, floor: 30 };

test("an unasked removal lowers the ceiling by three fragments under what is held", () => {
  assert.equal(ceilingAfterUnaskedRemoval(FULL), 102);
});

test("one removal never takes more than half the ceiling", () => {
  assert.equal(ceilingAfterUnaskedRemoval({ ...FULL, heldAheadSeconds: 40 }), 60);
});

test("repeated removals go down to the floor and stop there", () => {
  const seen = [];
  let ceiling = 120;
  for (let round = 0; round < 10; round += 1) {
    const next = ceilingAfterUnaskedRemoval({ ...FULL, ceiling, heldAheadSeconds: ceiling });
    if (next === ceiling) {
      break;
    }
    seen.push(next);
    ceiling = next;
  }
  assert.deepEqual(seen, [102, 84, 66, 48, 30]);
});

test("a removal never raises the ceiling", () => {
  // More held than the ceiling is what was appended before it was lowered; it
  // is not a reason to ask for more.
  assert.equal(ceilingAfterUnaskedRemoval({ ...FULL, ceiling: 83, heldAheadSeconds: 120 }), 83);
});

test("an unknown fragment length is hls.js's own default of six seconds", () => {
  assert.equal(ceilingAfterUnaskedRemoval({ ...FULL, fragmentSeconds: undefined }), 102);
  assert.equal(ceilingAfterUnaskedRemoval({ ...FULL, fragmentSeconds: Number.NaN }), 102);
});

test("no ceiling means nothing to lower", () => {
  assert.equal(ceilingAfterUnaskedRemoval({ ...FULL, ceiling: 0 }), 0);
});

/**
 * Played media evicted by the browser is the first sign of the device's limit.
 *
 * Field 2026-10-22: 42 s behind the playhead at 20:36:18 of the 30 s kept plus
 * a keyframe interval, 4 s at 20:36:48, and four minutes later nothing played
 * was left to evict and hls.js removed the frames being shown
 * (torrent-tv/meta#231). The ceiling gives the missing seconds back.
 */
const EVICTING = { ceiling: 120, behindSeconds: 11, aheadSeconds: 118, playedSeconds: 600, backBufferSeconds: 30, floor: 30 };

test("played media evicted below half the back buffer lowers the ceiling by what is missing", () => {
  assert.equal(ceilingWhilePlayedMediaIsEvicted(EVICTING), 101);
  assert.equal(ceilingWhilePlayedMediaIsEvicted({ ...EVICTING, ceiling: 101, behindSeconds: 4 }), 75);
});

test("hls.js's own trim leaves more than half the back buffer and changes nothing", () => {
  // It trims to 30 s behind and the browser extends that to the next keyframe.
  assert.equal(ceilingWhilePlayedMediaIsEvicted({ ...EVICTING, behindSeconds: 15 }), 120);
  assert.equal(ceilingWhilePlayedMediaIsEvicted({ ...EVICTING, behindSeconds: 22 }), 120);
});

test("a short back buffer right after a seek or the start is not an eviction", () => {
  assert.equal(ceilingWhilePlayedMediaIsEvicted({ ...EVICTING, playedSeconds: 44 }), 120);
  assert.equal(ceilingWhilePlayedMediaIsEvicted({ ...EVICTING, playedSeconds: 45 }), 101);
  assert.equal(ceilingWhilePlayedMediaIsEvicted({ ...EVICTING, playedSeconds: Number.NaN }), 120);
});

test("a playhead run past what was supplied is not an eviction", () => {
  // Field 2026-10-22 21:28:08 UTC: `0s behind, 0s ahead` at 22 Mbit/s over a
  // 15 Mbit/s link — outside any buffered range, nothing is behind either.
  assert.equal(ceilingWhilePlayedMediaIsEvicted({ ...EVICTING, ceiling: 75, behindSeconds: 0, aheadSeconds: 0 }), 75);
  assert.equal(ceilingWhilePlayedMediaIsEvicted({ ...EVICTING, aheadSeconds: 29 }), 120);
  assert.equal(ceilingWhilePlayedMediaIsEvicted({ ...EVICTING, aheadSeconds: Number.NaN }), 120);
  // The same run during a pause, the browser evicting for real: 14 s behind,
  // 47 s ahead.
  assert.equal(ceilingWhilePlayedMediaIsEvicted({ ...EVICTING, ceiling: 75, behindSeconds: 14, aheadSeconds: 47 }), 59);
  assert.equal(ceilingWhilePlayedMediaIsEvicted({ ...EVICTING, aheadSeconds: 30 }), 101);
});

test("the floor holds whatever is missing", () => {
  assert.equal(ceilingWhilePlayedMediaIsEvicted({ ...EVICTING, ceiling: 40, behindSeconds: 0 }), 30);
  assert.equal(ceilingWhilePlayedMediaIsEvicted({ ...EVICTING, ceiling: 30, behindSeconds: 0 }), 30);
});

test("no back buffer kept, or no ceiling, means nothing to read", () => {
  assert.equal(ceilingWhilePlayedMediaIsEvicted({ ...EVICTING, backBufferSeconds: 0 }), 120);
  assert.equal(ceilingWhilePlayedMediaIsEvicted({ ...EVICTING, ceiling: 0 }), 0);
});
