/**
 * The order a torrent's files are offered in.
 *
 * A torrent lists its files in whatever order the tool that made it chose, and
 * that is routinely by SIZE: the Drifters release lists its episodes 08, 06,
 * 07, 01, 02, 10, 11, 05, 09, 04, 12, 03, and the playlist showed exactly that
 * (field 2026-08-31).
 */

import assert from "node:assert/strict";
import test from "node:test";
import { classifyMediaFiles } from "../public/domain/torrent-parser.js";

/**
 * @param {string[]} paths
 * @returns {Array<{ index: number, relativePath: string, isVideo: boolean }>}
 */
function videoFiles(paths) {
  return paths.map((relativePath, index) => ({ index, relativePath, isVideo: true }));
}

test("episodes are offered in reading order, not in the torrent's own", () => {
  const asTheTorrentListsThem = ["08", "06", "07", "01", "02", "10", "11", "05", "09", "04", "12", "03"]
    .map((episode) => `[HorribleSubs] Drifters - ${episode} [1080p].mkv`);

  const { video } = classifyMediaFiles(videoFiles(asTheTorrentListsThem));

  assert.deepEqual(
    video.map((file) => file.relativePath.match(/- (\d+) /)[1]),
    ["01", "02", "03", "04", "05", "06", "07", "08", "09", "10", "11", "12"]
  );
});

test("sorting the display order never renumbers the files", () => {
  // Every entry carries `index`, the torrent's own number, and that is what a
  // file is opened by. Reordering the list must leave each entry's number on
  // it, or the viewer picks one episode and gets another.
  const paths = ["b/ep 2.mkv", "a/ep 1.mkv"];

  const { video } = classifyMediaFiles(videoFiles(paths));

  assert.deepEqual(video.map((file) => file.relativePath), ["a/ep 1.mkv", "b/ep 2.mkv"]);
  assert.deepEqual(video.map((file) => file.index), [1, 0], "the torrent's numbers travel with them");
});

test("runs of digits compare as numbers, so 2 comes before 10", () => {
  // Comparing the strings would put "10" before "2" — the same defect wearing
  // different clothes.
  const { video } = classifyMediaFiles(videoFiles(["ep10.mkv", "ep2.mkv", "ep1.mkv"]));

  assert.deepEqual(video.map((file) => file.relativePath), ["ep1.mkv", "ep2.mkv", "ep10.mkv"]);
});

test("folders order before names, so seasons stay together", () => {
  const { video } = classifyMediaFiles(
    videoFiles([
      "Season 2/ep 1.mkv",
      "Season 10/ep 1.mkv",
      "Season 1/ep 2.mkv",
      "Season 1/ep 1.mkv"
    ])
  );

  assert.deepEqual(video.map((file) => file.relativePath), [
    "Season 1/ep 1.mkv",
    "Season 1/ep 2.mkv",
    "Season 2/ep 1.mkv",
    "Season 10/ep 1.mkv"
  ]);
});

test("the sound and subtitle lists are ordered the same way", () => {
  const files = [
    { index: 0, relativePath: "Rus Sound/ep 10.mka" },
    { index: 1, relativePath: "Rus Sound/ep 2.mka" },
    { index: 2, relativePath: "Sub/ep 10.ass" },
    { index: 3, relativePath: "Sub/ep 2.ass" }
  ];

  const { audio, subtitles } = classifyMediaFiles(files);

  assert.deepEqual(audio.map((file) => file.relativePath), ["Rus Sound/ep 2.mka", "Rus Sound/ep 10.mka"]);
  assert.deepEqual(subtitles.map((file) => file.relativePath), ["Sub/ep 2.ass", "Sub/ep 10.ass"]);
});

test("what every name repeats is the release's, and comes off", () => {
  const { video } = classifyMediaFiles(
    videoFiles(
      ["01", "02", "12"].map((episode) => `[HorribleSubs] Drifters - ${episode} [1080p].mkv`)
    )
  );

  assert.deepEqual(video.map((file) => file.displayName), [
    "Drifters - 01",
    "Drifters - 02",
    "Drifters - 12"
  ]);
});

test("a bracket only some files carry stays, because it distinguishes them", () => {
  const { video } = classifyMediaFiles(
    videoFiles(["[Group] Show - 01 [1080p].mkv", "[Group] Show - 02 [720p].mkv"])
  );

  // `[Group]` is in both and goes; the two resolutions are not, and stay.
  assert.deepEqual(video.map((file) => file.displayName), [
    "Show - 01 [1080p]",
    "Show - 02 [720p]"
  ]);
});

test("a releaser written without brackets is left alone", () => {
  // Finding it would mean stripping the longest common text, and the title sits
  // in that same common text — it would go too.
  const { video } = classifyMediaFiles(
    videoFiles(["Drifters.01.WEBRip-GROUP.mkv", "Drifters.02.WEBRip-GROUP.mkv"])
  );

  assert.deepEqual(video.map((file) => file.displayName), [
    "Drifters.01.WEBRip-GROUP",
    "Drifters.02.WEBRip-GROUP"
  ]);
});

test("a single file keeps its whole name", () => {
  // With nothing to compare against every part is "common", and the whole name
  // would come off.
  const { video } = classifyMediaFiles(videoFiles(["[Group] Film [1080p].mkv"]));

  assert.equal(video[0].displayName, "[Group] Film [1080p].mkv");
});

test("when everything was furniture the full name is kept", () => {
  const { video } = classifyMediaFiles(videoFiles(["[A][B].mkv", "[A][B].mkv"]));

  assert.deepEqual(video.map((file) => file.displayName), ["[A][B].mkv", "[A][B].mkv"]);
});
