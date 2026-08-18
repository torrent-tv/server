/**
 * @file A fragment appended twice for nothing is a loop, and is stopped.
 *
 * The session this was written from: two audio segments fetched 737 and 736
 * times in 149 seconds while the playhead stood at 1061.0 s and the buffer
 * never grew (2026-08-18). Before this, nothing counted the repeats, so the
 * viewer waited on a player that had already given up.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { createRepeatGuard, fragmentKey } from "../public/domain/fruitless-repeat.js";

test("a fragment that keeps moving the buffer forward is never a loop", () => {
  const guard = createRepeatGuard();

  assert.equal(guard.note({ key: "main:0:1", bufferedEnd: 10 }).looping, false);
  assert.equal(guard.note({ key: "main:0:2", bufferedEnd: 20 }).looping, false);
  assert.equal(guard.note({ key: "main:0:3", bufferedEnd: 30 }).looping, false);
});

test("one fruitless repeat is tolerated — a flush we did not see explains it", () => {
  const guard = createRepeatGuard();

  guard.note({ key: "audio:0:103", bufferedEnd: 1061 });
  const second = guard.note({ key: "audio:0:103", bufferedEnd: 1061 });

  assert.equal(second.fruitless, 1);
  assert.equal(second.looping, false, "a re-append after a flush is ordinary work");
});

test("two fruitless repeats of the same fragment declare the loop", () => {
  const guard = createRepeatGuard();

  guard.note({ key: "audio:0:103", bufferedEnd: 1061 });
  guard.note({ key: "audio:0:103", bufferedEnd: 1061 });
  const third = guard.note({ key: "audio:0:103", bufferedEnd: 1061 });

  assert.equal(third.fruitless, 2);
  assert.equal(third.looping, true, "bytes that added nothing twice will add nothing again");
});

test("a repeat that DID move the buffer starts the count over", () => {
  const guard = createRepeatGuard();

  guard.note({ key: "audio:0:103", bufferedEnd: 1061 });
  guard.note({ key: "audio:0:103", bufferedEnd: 1061 });
  const grew = guard.note({ key: "audio:0:103", bufferedEnd: 1065 });
  assert.equal(grew.fruitless, 0);
  assert.equal(grew.looping, false);

  const afterGrowth = guard.note({ key: "audio:0:103", bufferedEnd: 1065 });
  assert.equal(afterGrowth.looping, false, "only CONSECUTIVE fruitless appends count");
});

test("a flush clears the history, because a re-append is then expected", () => {
  const guard = createRepeatGuard();

  guard.note({ key: "audio:0:103", bufferedEnd: 1061 });
  guard.note({ key: "audio:0:103", bufferedEnd: 1061 });
  guard.forget();
  const afterFlush = guard.note({ key: "audio:0:103", bufferedEnd: 1061 });

  assert.equal(afterFlush.looping, false);
  assert.equal(afterFlush.fruitless, 0);
});

test("the picture and the soundtrack are counted apart", () => {
  const guard = createRepeatGuard();

  // The field case: the audio rendition looped while the video stood still at
  // the same sequence number. Counted together, the two would mask each other.
  assert.equal(fragmentKey({ type: "audio", level: 0, sn: 103 }), "audio:0:103");
  assert.equal(fragmentKey({ type: "main", level: 0, sn: 103 }), "main:0:103");
  assert.equal(fragmentKey({ sn: 7 }), "main:-1:7", "an unnamed stream is the picture");

  guard.note({ key: "audio:0:103", bufferedEnd: 1061 });
  guard.note({ key: "main:0:103", bufferedEnd: 1061 });
  guard.note({ key: "audio:0:103", bufferedEnd: 1061 });
  const audioThird = guard.note({ key: "audio:0:103", bufferedEnd: 1061 });

  assert.equal(audioThird.looping, true);
});
