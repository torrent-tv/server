/**
 * @file Reading release names, and deciding which work they identify.
 *
 * The names are from the survey collection (`Dropbox/trn`); the search answers
 * are built by hand to reach each rule.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { parseReleaseName } from "../services/metadata/release-name.js";
import { decideIdentity } from "../services/metadata/identification.js";
import { normalizeTitle } from "../services/metadata/title.js";

test("two spellings of one title compare equal", () => {
  assert.equal(normalizeTitle("Agatha Christie`s Poirot"), normalizeTitle("Agatha Christie's Poirot"));
  assert.equal(normalizeTitle("Nausicaa of the Valley of the Wind"), normalizeTitle("Nausicaä of the Valley of the Wind"));
  assert.equal(normalizeTitle("One,Two,Buckle.My.Shoe"), normalizeTitle("One, Two, Buckle My Shoe"));
  assert.equal(normalizeTitle("Curtain.Poirot's.Last.Case"), normalizeTitle("Curtain: Poirot's Last Case"));
});

test("a Cyrillic and a Latin title with nothing between them are two titles", () => {
  const name = parseReleaseName("Пуаро_Агаты_Кристи_Agatha_Christie`s_Poirot_Сезон_1_13_из_13_Серии.torrent");
  assert.deepEqual(name.titles, ["Пуаро Агаты Кристи", "Agatha Christie`s Poirot"]);
  assert.equal(name.seriesEvidence, true);
});

test("a span of years is a series and its first year is the one compared", () => {
  const name = parseReleaseName("Poirot.1989-2013.hdrip_[teko]");
  assert.deepEqual(name.titles, ["Poirot"]);
  assert.deepEqual(name.years, { from: 1989, to: 2013 });
  assert.equal(name.seriesEvidence, true);
});

test("titles, the year and TV are read from a tracker's bracketed name", () => {
  const name = parseReleaseName(
    "Скитальцы (ТВ-1) Drifters Заблудшие [TV] [12 из 12] [RUS(ext), JAP+Sub] [2016, приключения, комедия, фэнтези, WEBRip] [1080p] [rutracker-5323242].torrent"
  );
  assert.deepEqual(name.titles, ["Скитальцы", "Drifters", "Заблудшие"]);
  assert.deepEqual(name.years, { from: 2016, to: 2016 });
  assert.equal(name.seriesEvidence, true);
});

test("digits stay with the title they follow", () => {
  const name = parseReleaseName("Микки 17 Mickey 17 (Пон Джун-хо Bong Joon-ho) [2025, США, фантастика] Dub (Профессиона [rutracker-6712626].torrent");
  assert.deepEqual(name.titles, ["Микки 17", "Mickey 17"]);
  assert.equal(name.years.from, 2025);
});

test("the title ends at the year, and a sequel's number is part of it", () => {
  assert.deepEqual(parseReleaseName("Despicable.Me.4.2024.1080p.BluRay.x264-EniaHD").titles, ["Despicable Me 4"]);
  assert.deepEqual(parseReleaseName("Moana.2.2024.720p.BluRay.DD.5.1.x264-MegaPeer").titles, ["Moana 2"]);
  assert.deepEqual(parseReleaseName("A.Nightmare.on.Elm.Street.1080p.rus.LostFilm.TV.mkv").titles, ["A Nightmare on Elm Street"]);
  assert.equal(parseReleaseName("A.Nightmare.on.Elm.Street.1080p.rus.LostFilm.TV.mkv").years, null);
});

/**
 * @param {"tv" | "movie"} kind
 * @param {string} query
 * @param {Array<[number, string, number | null]>} results
 * @param {"complete" | "capped" | "failed"} [status]
 */
const search = (kind, query, results, status = "complete") => ({
  kind,
  query: normalizeTitle(query),
  status,
  results: results.map(([id, name, year]) => ({ id, name, originalName: name, year }))
});

test("one exact title in a complete search is identified", () => {
  const identity = decideIdentity({
    searches: [
      search("tv", "Agatha Christie's Poirot", [[790, "Agatha Christie's Poirot", 1989], [47134, "Agatha Christie's Great Detectives Poirot and Marple", 2004]]),
      search("tv", "Poirot", [[1, "Loriot", 1976]])
    ],
    statedYears: [1989]
  });
  assert.equal(identity.status, "identified");
  assert.equal(identity.candidates[0].tmdbId, 790);
});

test("the first search result is not taken for being first", () => {
  const identity = decideIdentity({ searches: [search("movie", "Superman", [[9, "Superman Returns", 2006]])], statedYears: [] });
  assert.equal(identity.status, "not-found");
});

test("a remake with no year stated is ambiguous, and the year separates it", () => {
  const results = [[1, "A Nightmare on Elm Street", 1984], [2, "A Nightmare on Elm Street", 2010]];
  assert.equal(decideIdentity({ searches: [search("movie", "A Nightmare on Elm Street", results)], statedYears: [] }).status, "ambiguous");
  const dated = decideIdentity({ searches: [search("movie", "A Nightmare on Elm Street", results)], statedYears: [2010] });
  assert.equal(dated.status, "identified");
  assert.equal(dated.candidates[0].tmdbId, 2);
});

test("a result with no date is never a candidate", () => {
  const identity = decideIdentity({ searches: [search("tv", "The Continental", [[19069, "The Continental", null]])], statedYears: [] });
  assert.equal(identity.status, "not-found");
});

test("a year one away agrees; two away does not", () => {
  const results = [[1, "Title", 2016]];
  assert.equal(decideIdentity({ searches: [search("movie", "Title", results)], statedYears: [2017] }).status, "identified");
  assert.equal(decideIdentity({ searches: [search("movie", "Title", results)], statedYears: [2018] }).status, "not-found");
});

test("a film and a series of one title, with the kind unknown, are ambiguous", () => {
  const identity = decideIdentity({
    searches: [search("tv", "Frankenstein", [[5, "Frankenstein", 2004]]), search("movie", "Frankenstein", [[6, "Frankenstein", 1931]])],
    statedYears: []
  });
  assert.equal(identity.status, "ambiguous");
});

test("one candidate while another search failed is not identified", () => {
  const identity = decideIdentity({
    searches: [search("movie", "Title", [[1, "Title", 2020]]), search("tv", "Title", [], "failed")],
    statedYears: []
  });
  assert.equal(identity.status, "unavailable");
});

test("uniqueness among the pages read is not uniqueness of the search", () => {
  const identity = decideIdentity({ searches: [search("movie", "Title", [[1, "Title", 2020]], "capped")], statedYears: [] });
  assert.equal(identity.status, "undetermined");
});

test("two names pointing at two works are ambiguous even if one search failed", () => {
  const identity = decideIdentity({
    searches: [search("tv", "Alpha", [[1, "Alpha", 2000]]), search("tv", "Beta", [[2, "Beta", 2000]]), search("tv", "Gamma", [], "failed")],
    statedYears: []
  });
  assert.equal(identity.status, "ambiguous");
});

test("a series whose episodes carry the files' titles is identified by them", async () => {
  const { decideByEpisodeTitles } = await import("../services/metadata/identification.js");
  const candidate = (tmdbId) => ({ kind: "tv", tmdbId, title: "", year: 1989 });
  const titles = ["The.Adventure.of.the.Clapham.Cook", "Murder.in.the.Mews", "The.Dream"];
  const poirot = ["The Adventure of the Clapham Cook", "Murder in the Mews", "The Adventure of Johnnie Waverly", "The Dream"];
  assert.equal(
    decideByEpisodeTitles({ checked: [{ candidate: candidate(790), episodeNames: poirot }, { candidate: candidate(2), episodeNames: ["Pilot"] }], titles, uncheckedRemain: false }).candidates[0].tmdbId,
    790
  );
  // One shared title is not enough, and neither is a minority of the titles.
  assert.equal(decideByEpisodeTitles({ checked: [{ candidate: candidate(3), episodeNames: ["The Dream"] }], titles, uncheckedRemain: false }).status, "not-found");
  assert.equal(
    decideByEpisodeTitles({ checked: [{ candidate: candidate(4), episodeNames: ["Murder in the Mews", "The Dream"] }], titles: [...titles, "A", "B", "C"], uncheckedRemain: false }).status,
    "not-found"
  );
  assert.equal(decideByEpisodeTitles({ checked: [], titles, uncheckedRemain: true }).status, "undetermined");
  assert.equal(
    decideByEpisodeTitles({ checked: [{ candidate: candidate(5), episodeNames: poirot }, { candidate: candidate(6), episodeNames: poirot }], titles, uncheckedRemain: false }).status,
    "ambiguous"
  );
});
