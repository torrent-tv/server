/**
 * @file What the page does with the proxy's answer about a torrent.
 *
 * It does not decide what a file is, and it does not decide what order the
 * files come in: both are answered once, by the proxy, and this page shows what
 * it is given. Until 2026-09-12 it decided both again — with a list of video
 * extensions in the parser and a second, shorter pair inside the picker — and
 * the three answers had already diverged.
 *
 * What is left here is presentation: keep the order that arrived, keep each
 * file's own number, and shorten the names by the part every one of them
 * repeats.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { mediaFilesFrom } from "../public/domain/torrent-parser.js";

/**
 * The proxy's answer, in the shape it arrives in.
 *
 * @param {string[]} paths - Pictures, in the order the proxy gave them.
 * @returns {{ files: object[], items: object[] }}
 */
function contentsOf(paths) {
  const files = paths.map((relativePath, index) => ({
    index,
    name: relativePath.slice(relativePath.lastIndexOf("/") + 1),
    relativePath,
    length: 1,
    kind: "video"
  }));
  return { files, items: files.map((file) => ({ fileIndex: file.index })) };
}

test("the order the proxy gave is the order the viewer sees", () => {
  // A torrent lists its files in whatever order the tool that made it chose,
  // and that is routinely by SIZE — the Drifters release lists its episodes 08,
  // 06, 07, 01, 02, 10 (field 2026-08-31). Putting that right is the proxy's
  // job now, and this page must not undo it by sorting again on its own rules.
  const asThePersonReadsThem = ["01", "02", "03", "10", "11", "12"].map(
    (episode) => `[HorribleSubs] Drifters - ${episode} [1080p].mkv`
  );

  const { video } = mediaFilesFrom(contentsOf(asThePersonReadsThem).files, contentsOf(asThePersonReadsThem).items);

  assert.deepEqual(
    video.map((file) => file.relativePath.match(/- (\d+) /)[1]),
    ["01", "02", "03", "10", "11", "12"]
  );
});

test("every entry keeps the torrent's own number", () => {
  // That number is what a file is opened by. Lose it and the viewer picks one
  // episode and gets another.
  const contents = contentsOf(["a/ep 1.mkv", "b/ep 2.mkv"]);
  contents.files[0].index = 7;
  contents.files[1].index = 3;
  contents.items = [{ fileIndex: 7 }, { fileIndex: 3 }];

  const { video } = mediaFilesFrom(contents.files, contents.items);

  assert.deepEqual(video.map((file) => file.index), [7, 3]);
});

test("the sound and the subtitles of each picture are offered with it", () => {
  const files = [
    { index: 0, name: "ep 1.mkv", relativePath: "ep 1.mkv", length: 9, kind: "video" },
    { index: 1, name: "ep 1.mka", relativePath: "Rus Sound/ep 1.mka", length: 2, kind: "audio" },
    { index: 2, name: "ep 1.ass", relativePath: "Sub/ep 1.ass", length: 1, kind: "subtitle" }
  ];
  const items = [{ fileIndex: 0, audio: [1], subtitles: [2] }];

  const { video, audio, subtitles } = mediaFilesFrom(files, items);

  assert.deepEqual(video.map((file) => file.index), [0]);
  assert.deepEqual(audio.map((file) => file.index), [1]);
  assert.deepEqual(subtitles.map((file) => file.index), [2]);
});

test("a soundtrack that belongs to no picture is still offered", () => {
  // A viewer can choose it, and hiding it because a name matched nothing would
  // take away something the release ships.
  const files = [
    { index: 0, name: "film.mkv", relativePath: "film.mkv", length: 9, kind: "video" },
    { index: 1, name: "stray.mka", relativePath: "Other/stray.mka", length: 2, kind: "audio" }
  ];

  const { audio } = mediaFilesFrom(files, [{ fileIndex: 0 }]);

  assert.deepEqual(audio.map((file) => file.index), [1]);
});

test("a file is never offered twice, however many ways it is named", () => {
  const files = [
    { index: 0, name: "film.mkv", relativePath: "film.mkv", length: 9, kind: "video" },
    { index: 1, name: "dub.mka", relativePath: "dub.mka", length: 2, kind: "audio" }
  ];

  const { audio } = mediaFilesFrom(files, [{ fileIndex: 0, audio: [1] }]);

  assert.equal(audio.length, 1, "the item's own list and the leftover sweep both took it");
});

test("what every name repeats is the release's, and comes off", () => {
  const contents = contentsOf(
    ["01", "02", "12"].map((episode) => `[HorribleSubs] Drifters - ${episode} [1080p].mkv`)
  );

  const { video } = mediaFilesFrom(contents.files, contents.items);

  assert.deepEqual(video.map((file) => file.displayName), [
    "Drifters - 01",
    "Drifters - 02",
    "Drifters - 12"
  ]);
});

test("a bracket only some files carry stays, because it distinguishes them", () => {
  const contents = contentsOf(["[Group] Show - 01 [1080p].mkv", "[Group] Show - 02 [720p].mkv"]);

  const { video } = mediaFilesFrom(contents.files, contents.items);

  // `[Group]` is in both and goes; the two resolutions are not, and stay.
  assert.deepEqual(video.map((file) => file.displayName), [
    "Show - 01 [1080p]",
    "Show - 02 [720p]"
  ]);
});

test("a releaser written without brackets is left alone", () => {
  // Finding it would mean stripping the longest common text, and the title sits
  // in that same common text — it would go too.
  const contents = contentsOf(["Drifters.01.WEBRip-GROUP.mkv", "Drifters.02.WEBRip-GROUP.mkv"]);

  const { video } = mediaFilesFrom(contents.files, contents.items);

  assert.deepEqual(video.map((file) => file.displayName), [
    "Drifters.01.WEBRip-GROUP",
    "Drifters.02.WEBRip-GROUP"
  ]);
});

test("a single file keeps its whole name, having nothing to be compared against", () => {
  const contents = contentsOf(["[Group] Show - 01 [1080p].mkv"]);

  const { video } = mediaFilesFrom(contents.files, contents.items);

  assert.equal(video[0].displayName, "[Group] Show - 01 [1080p].mkv");
});
