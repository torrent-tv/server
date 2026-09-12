/**
 * @file A proxy that did not say what is in a torrent must not be read as one
 * that said "nothing".
 *
 * Field 2026-09-12: the proxy on the addon host was one release behind the page
 * and answered the shape that predated this question — a file list with no
 * `items`. The page builds the list of pictures from `items` alone, so it came
 * out empty, and the viewer was told "No video file found in this torrent" on
 * every torrent they opened, including one whose single file was an `.mkv`.
 * Nothing had established that.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { mediaFilesFrom, statesWhatIsInTheTorrent } from "../public/domain/torrent-parser.js";

test("an answer carrying no items states nothing", () => {
  assert.equal(
    statesWhatIsInTheTorrent({
      name: "Reacher.S04E07.1080p.rus.LostFilm.TV.mkv",
      infoHash: "5d276be5",
      files: [{ index: 0, name: "Reacher.S04E07.1080p.rus.LostFilm.TV.mkv", length: 1 }]
    }),
    false,
    "the shape a proxy one release behind answers with"
  );
});

test("an empty list of items IS a statement", () => {
  assert.equal(
    statesWhatIsInTheTorrent({ files: [{ index: 0, name: "cover.jpg", length: 1 }], items: [] }),
    true,
    "the proxy looked and found no picture — that is an answer about the torrent"
  );
});

test("nothing at all states nothing", () => {
  assert.equal(statesWhatIsInTheTorrent(undefined), false);
  assert.equal(statesWhatIsInTheTorrent({}), false);
  assert.equal(statesWhatIsInTheTorrent({ items: "0" }), false);
});

test("the two cases are indistinguishable one step further on", () => {
  const files = [{ index: 0, name: "Reacher.S04E07.mkv", length: 1 }];
  const notStated = mediaFilesFrom(files, undefined);
  const statedEmpty = mediaFilesFrom(files, []);
  assert.equal(notStated.video.length, 0);
  assert.equal(statedEmpty.video.length, 0);
});
