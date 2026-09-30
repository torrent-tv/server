/**
 * @file Which pictures the playlist folds into a group of their folder, and what
 * each row is called.
 *
 * The shapes are the three the test torrents actually have (2026-09-30, 148
 * torrents): a folder per season, a folder per performer where many folders
 * hold one picture, and everything flat.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { playlistRows } from "../public/domain/playlist-groups.js";

/**
 * @param {string[]} paths - Pictures, in the order the proxy gave them.
 * @returns {object[]} Entries as `SET_MEDIA_FILES` carries them.
 */
function filesOf(paths) {
  return paths.map((relativePath, index) => ({
    index,
    relativePath,
    displayName: relativePath.replace(/\.[a-z0-9]{2,4}$/i, "")
  }));
}

/** @param {ReturnType<typeof playlistRows>} rows */
function shapeOf(rows) {
  return rows.map((row) =>
    row.kind === "group" ? { group: row.label, files: row.files.map((member) => member.label) } : row.label
  );
}

test("a folder per season becomes a group per season, in the order given", () => {
  const rows = playlistRows(
    filesOf([
      "Season_01/s01e01_The.Adventure.of.the.Clapham.Cook.avi",
      "Season_01/s01e02_Murder.in.the.Mews.avi",
      "Season_02/s02e01_Peril.at.End.House_Part.1.avi",
      "Season_02/s02e02_Peril.at.End.House_Part.2.avi"
    ])
  );
  assert.deepEqual(shapeOf(rows), [
    { group: "Season_01", files: ["s01e01_The.Adventure.of.the.Clapham.Cook", "s01e02_Murder.in.the.Mews"] },
    { group: "Season_02", files: ["s02e01_Peril.at.End.House_Part.1", "s02e02_Peril.at.End.House_Part.2"] }
  ]);
});

test("each row keeps its own file number", () => {
  const rows = playlistRows(filesOf(["S01/a.mkv", "S01/b.mkv", "S02/c.mkv", "S02/d.mkv"]));
  const indexes = rows.flatMap((row) => row.files.map((member) => member.file.index));
  assert.deepEqual(indexes, [0, 1, 2, 3]);
});

test("a folder holding one picture stays a plain row with its full name", () => {
  const rows = playlistRows(filesOf(["alen/one.mp4", "allie/one.mp4", "allie/two.mp4", "zoe/one.mp4"]));
  assert.deepEqual(shapeOf(rows), ["alen/one", { group: "allie", files: ["one", "two"] }, "zoe/one"]);
});

test("a folder holding every picture hides nothing, so the list stays flat", () => {
  const rows = playlistRows(filesOf(["Show/e01.mkv", "Show/e02.mkv", "Show/e03.mkv"]));
  assert.deepEqual(shapeOf(rows), ["Show/e01", "Show/e02", "Show/e03"]);
});

test("pictures at the root stay rows beside the groups", () => {
  const rows = playlistRows(filesOf(["Movie.mkv", "Extras/a.mkv", "Extras/b.mkv"]));
  assert.deepEqual(shapeOf(rows), ["Movie", { group: "Extras", files: ["a", "b"] }]);
});

test("a flat torrent is shown exactly as before", () => {
  const rows = playlistRows(filesOf(["e01.mkv", "e02.mkv"]));
  assert.deepEqual(shapeOf(rows), ["e01", "e02"]);
});

test("a folder name is shown as the release wrote it", () => {
  const rows = playlistRows(filesOf(["S.W.A.T/a.mkv", "S.W.A.T/b.mkv", "Other/c.mkv", "Other/d.mkv"]));
  assert.deepEqual(
    rows.map((row) => row.label),
    ["S.W.A.T", "Other"]
  );
});
