/**
 * @file A failed media element: what the failure is, who caused the pause
 * after it, where it happened, and the next step against it.
 *
 * Field 2026-10-04: the element failed at 1189.2 s with 117.8 s buffered, the
 * pause it made was read as the viewer's, and hls.js's own reset, run 4.7 s
 * later, put the picture back at zero with nobody to start it.
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  describeMediaFailure,
  ELEMENT_RECOVERY_STEP,
  elementRecoveryStep,
  MEDIA_FAILURE_KIND
} from "../public/domain/media-failure.js";
import {
  consumePauseCause,
  noteElementFailed,
  noteElementRecovered,
  PAUSE_CAUSE
} from "../public/domain/playback-intent.js";
import { fragmentAt } from "../public/domain/hls-player.js";

test("the element's code is named and its message kept whole", () => {
  assert.deepEqual(
    describeMediaFailure({ code: 3, message: "PIPELINE_ERROR_DECODE: video decode failed" }),
    { code: 3, kind: MEDIA_FAILURE_KIND.DECODE, message: "PIPELINE_ERROR_DECODE: video decode failed" }
  );
  assert.equal(describeMediaFailure({ code: 1 }).kind, MEDIA_FAILURE_KIND.ABORTED);
  assert.equal(describeMediaFailure({ code: 2 }).kind, MEDIA_FAILURE_KIND.NETWORK);
  assert.equal(describeMediaFailure({ code: 4 }).kind, MEDIA_FAILURE_KIND.UNSUPPORTED);
  assert.equal(describeMediaFailure({ code: 9 }).kind, MEDIA_FAILURE_KIND.UNKNOWN);
  assert.deepEqual(describeMediaFailure(null), { code: null, kind: MEDIA_FAILURE_KIND.NONE, message: "" });
});

test("the first failure at a place rebuilds there; a failure after that rebuild restarts the stream", () => {
  const failure = describeMediaFailure({ code: 3, message: "" });
  assert.equal(
    elementRecoveryStep({ failure, rebuildsHere: 0, manifestReady: true }),
    ELEMENT_RECOVERY_STEP.REBUILD_AT_POSITION
  );
  assert.equal(
    elementRecoveryStep({ failure, rebuildsHere: 1, manifestReady: true }),
    ELEMENT_RECOVERY_STEP.RESTART_STREAM
  );
});

test("before the manifest is in, the start-up flow owns the failure", () => {
  const failure = describeMediaFailure({ code: 4, message: "" });
  assert.equal(
    elementRecoveryStep({ failure, rebuildsHere: 0, manifestReady: false }),
    ELEMENT_RECOVERY_STEP.LEAVE_TO_START_UP
  );
});

test("the pause after a failure is the element's, and only that one", () => {
  const video = {};
  noteElementFailed(video);
  assert.equal(consumePauseCause(video), PAUSE_CAUSE.ELEMENT);
  assert.equal(consumePauseCause(video), PAUSE_CAUSE.VIEWER);
});

test("a failure that is over leaves the viewer's next pause theirs", () => {
  const video = {};
  noteElementFailed(video);
  noteElementRecovered(video);
  assert.equal(consumePauseCause(video), PAUSE_CAUSE.VIEWER);
});

test("a failure's place is the fragment holding the position", () => {
  const fragments = [
    { sn: 188, start: 1178.0, duration: 6.0 },
    { sn: 189, start: 1184.0, duration: 6.4 },
    { sn: 190, start: 1190.4, duration: 5.6 }
  ];
  assert.deepEqual(fragmentAt(fragments, 1189.2), { sn: 189, start: 1184.0, end: 1190.4 });
  // A boundary belongs to the fragment that begins there.
  assert.equal(fragmentAt(fragments, 1190.4)?.sn, 190);
  assert.equal(fragmentAt(fragments, 1200), null);
  assert.equal(fragmentAt(null, 10), null);
  assert.equal(fragmentAt(fragments, Number.NaN), null);
});
