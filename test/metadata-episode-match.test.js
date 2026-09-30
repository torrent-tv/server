/**
 * @file Which episode of a season each file of a release is.
 *
 * The Poirot release is the reference case: 71 files against TMDB's 70
 * episodes, with two numbering differences checked by hand against TMDB's own
 * season pages before any rule was written:
 *
 *  - season 2: `s02e01` and `s02e02` are parts 1 and 2 of TMDB's S02E01 "Peril
 *    at End House", so `s02e03`..`s02e10` are TMDB's S02E02..S02E09;
 *  - season 12: the release's order is The Clocks, Three Act Tragedy,
 *    Hallowe'en Party, Murder on the Orient Express; TMDB's is Three Act
 *    Tragedy, Hallowe'en Party, Murder on the Orient Express, The Clocks.
 *
 * Every other file has TMDB's number. That table is the expectation below; it
 * was not produced by the code it checks.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { matchSeason } from "../services/metadata/episode-match.js";

const poirot = JSON.parse(readFileSync(new URL("./fixtures/poirot.json", import.meta.url), "utf8"));

/** Where the release's number is NOT TMDB's, as `season:releaseNumber:part` → TMDB episode. */
const DIFFERENT = new Map([
  ["2:1:1", 1],
  ["2:2:2", 1],
  ["2:3:", 2],
  ["2:4:", 3],
  ["2:5:", 4],
  ["2:6:", 5],
  ["2:7:", 6],
  ["2:8:", 7],
  ["2:9:", 8],
  ["2:10:", 9],
  ["12:1:", 4],
  ["12:2:", 1],
  ["12:3:", 2],
  ["12:4:", 3]
]);

/**
 * @param {number} number
 * @param {string} name
 * @returns {{ number: number, name: string, still: null }}
 */
const episode = (number, name) => ({ number, name, still: null });

test("every Poirot file is the episode the hand-checked table says", () => {
  let files = 0;
  for (const [seasonText, episodes] of Object.entries(poirot.tmdbSeasons)) {
    const season = Number(seasonText);
    const release = poirot.release.filter((file) => file.season === season);
    const matches = matchSeason(release, { number: season, name: `Season ${season}`, episodes });
    for (const file of release) {
      const match = matches.find((one) => one.key === file.key);
      const different = DIFFERENT.get(`${season}:${file.episodes[0]}:${file.part ?? ""}`);
      const expected = different ?? file.episodes[0];
      assert.equal(match.status, "matched", file.file);
      assert.deepEqual(match.episodes.map((one) => one.number), [expected], file.file);
      assert.equal(match.part, file.part, file.file);
      files += 1;
    }
  }
  assert.equal(files, 71);
});

test("a title that matches nothing leaves the number to decide", () => {
  const season = { number: 4, name: "", episodes: [episode(1, "A"), episode(2, "B")] };
  const matches = matchSeason(
    [
      { key: "a", episodes: [1], titleHint: "1080p.rus.LostFilm.TV" },
      { key: "b", episodes: [2], titleHint: "" }
    ],
    season
  );
  assert.deepEqual(matches.map((one) => [one.status, one.episodes[0]?.number]), [["matched", 1], ["matched", 2]]);
});

test("once a title shows the numbering differs, a number alone names nothing in that season", () => {
  const season = { number: 1, name: "", episodes: [episode(1, "Pilot"), episode(2, "Second"), episode(3, "Third")] };
  const matches = matchSeason(
    [
      { key: "a", episodes: [1], titleHint: "Second" },
      { key: "b", episodes: [3], titleHint: "" }
    ],
    season
  );
  assert.equal(matches[0].status, "matched");
  assert.equal(matches[0].episodes[0].number, 2);
  assert.equal(matches[1].status, "unmatched");
});

test("a part is matched only by its title", () => {
  const season = { number: 1, name: "", episodes: [episode(1, "Long Story"), episode(2, "Other")] };
  const [titled, untitled] = matchSeason(
    [
      { key: "a", episodes: [1], part: 1, titleHint: "Long.Story" },
      { key: "b", episodes: [2], part: 2, titleHint: "" }
    ],
    season
  );
  assert.equal(titled.status, "matched");
  assert.equal(untitled.status, "unmatched");
});

test("a file carrying two episodes is matched to both", () => {
  const season = { number: 1, name: "", episodes: [episode(1, "One"), episode(2, "Two"), episode(3, "Three")] };
  const [both] = matchSeason([{ key: "a", episodes: [1, 2], titleHint: "" }], season);
  assert.equal(both.status, "matched");
  assert.deepEqual(both.episodes.map((one) => one.number), [1, 2]);
});

test("a file carrying episodes the season does not have is not matched", () => {
  const season = { number: 1, name: "", episodes: [episode(1, "One")] };
  assert.equal(matchSeason([{ key: "a", episodes: [1, 2] }], season)[0].status, "unmatched");
});

test("a number the season does not have stops matching by number in the whole season", () => {
  // Firefly as TMDB lists it (eleven episodes, broadcast order) against a
  // release of fourteen in production order, titles carrying only tags.
  const names = ["The Train Job", "Bushwhacked", "Our Mrs. Reynolds", "Jaynestown", "Out of Gas", "Shindig", "Safe", "Ariel", "War Stories", "Objects in Space", "Serenity"];
  const season = { number: 1, name: "Season 1", episodes: names.map((name, index) => episode(index + 1, name)) };
  const files = Array.from({ length: 14 }, (_, index) => ({ key: String(index + 1), episodes: [index + 1], titleHint: "1080p.rus.LostFilm.TV" }));
  assert.ok(matchSeason(files, season).every((match) => match.status === "unmatched"));
});

test("a special is matched by its title and never by its number", () => {
  const season = { number: 0, name: "Specials", episodes: [episode(1, "Christmas Special"), episode(2, "Other")] };
  const [titled, numbered] = matchSeason(
    [
      { key: "a", episodes: [7], special: true, titleHint: "Christmas.Special" },
      { key: "b", episodes: [2], special: true, titleHint: "" }
    ],
    season
  );
  assert.equal(titled.status, "matched");
  assert.equal(numbered.status, "unmatched");
});

test("a title shared by two episodes is ambiguous", () => {
  const season = { number: 1, name: "", episodes: [episode(1, "Homecoming"), episode(5, "Homecoming")] };
  assert.equal(matchSeason([{ key: "a", episodes: [1], titleHint: "Homecoming" }], season)[0].status, "ambiguous");
});

test("two files claiming one episode are both ambiguous", () => {
  const season = { number: 1, name: "", episodes: [episode(1, "One")] };
  const matches = matchSeason(
    [
      { key: "a", episodes: [1], titleHint: "" },
      { key: "b", episodes: [1], titleHint: "" }
    ],
    season
  );
  assert.deepEqual(matches.map((one) => one.status), ["ambiguous", "ambiguous"]);
});
