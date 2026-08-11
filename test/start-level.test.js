/**
 * @file Which quality variant playback starts on.
 *
 * With a master playlist the player would otherwise choose for itself, and with
 * no throughput measured yet it chooses the lowest rung. Every rung is a
 * separate ffmpeg run on the proxy, so that choice is a cold start the viewer
 * waits through before the first frame — while an encoder is already producing
 * the height the session was created at.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { chooseStartLevel } from "../public/domain/hls-player.js";

// The order hls.js reports: lowest first. Written that way deliberately — an
// earlier version of this test used the descending order of the master playlist
// and so could not catch an index taken from the wrong end.
const LEVELS = [{ height: 240 }, { height: 540 }, { height: 720 }, { height: 812 }, { height: 1080 }];

test("the height the proxy is already encoding is the one playback starts on", () => {
  assert.equal(chooseStartLevel(LEVELS, 812), 3);
  assert.equal(chooseStartLevel(LEVELS, 240), 0);
});

test("a height the master does not list falls to the nearest rung", () => {
  // Should not happen — the master is built from the same session that reports
  // this height — but the alternative is leaving the choice to the player.
  assert.equal(chooseStartLevel(LEVELS, 800), 3, "812 is nearer to 800 than 720 is");
  assert.equal(chooseStartLevel(LEVELS, 100), 0);
});

test("nothing to pin when there is one variant or none", () => {
  assert.equal(chooseStartLevel([{ height: 1080 }], 1080), -1, "a media playlist has no choice to make");
  assert.equal(chooseStartLevel([], 720), -1);
  assert.equal(chooseStartLevel(null, 720), -1);
});

test("with no height reported, the tallest rung — never the player's own guess", () => {
  // An older proxy, or a response that lost the field. Taking the first index
  // would start the viewer on the smallest picture the file is offered at,
  // which is the outcome this whole path exists to prevent.
  assert.equal(chooseStartLevel(LEVELS, 0), 4);
  assert.equal(chooseStartLevel(LEVELS, undefined), 4);
});
