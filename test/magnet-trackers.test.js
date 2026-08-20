/**
 * @file A magnet that names no tracker is a different failure from a swarm
 * nobody is in, and the viewer is told which one it is.
 *
 * Established 2026-08-20: this app's own share links carry every tracker of the
 * original `.torrent` and reached 52-67 seeders on a film a bare magnet found
 * nobody for. So "no peers reachable" was naming a consequence, after a full
 * minute of waiting, for a link that had simply never asked a tracker anything.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { magnetNamesATracker } from "../public/domain/torrent-parser.js";

const HASH = "magnet:?xt=urn:btih:3634277d40c133c53d9112ad6f7eb35c52770041";

test("a magnet carrying trackers is recognised as carrying them", () => {
  assert.equal(
    magnetNamesATracker(`${HASH}&dn=Film.mkv&tr=${encodeURIComponent("udp://opentor.net:6969")}`),
    true
  );
  // Several, which is what a share link from this app looks like.
  assert.equal(
    magnetNamesATracker(
      `${HASH}&tr=${encodeURIComponent("udp://a:6969")}&tr=${encodeURIComponent("http://b/announce")}`
    ),
    true
  );
});

test("a bare magnet names none", () => {
  assert.equal(magnetNamesATracker(HASH), false);
  assert.equal(magnetNamesATracker(`${HASH}&dn=Film.mkv`), false);
});

test("an empty tracker parameter is not a tracker", () => {
  assert.equal(magnetNamesATracker(`${HASH}&tr=`), false);
  assert.equal(magnetNamesATracker(`${HASH}&tr=%20`), false);
});

test("nothing readable is not a claim that trackers exist", () => {
  assert.equal(magnetNamesATracker(""), false);
  assert.equal(magnetNamesATracker(null), false);
  assert.equal(magnetNamesATracker("not a magnet at all"), false);
});
