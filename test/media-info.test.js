/**
 * @file What the page asks the metadata service, how the answers become names
 * and pictures, and that an answer for a replaced choice changes nothing.
 *
 * The component runs against an `EventTarget` standing in for `document` and a
 * `fetch` whose answers the test releases by hand, so the order of events is
 * the test's to choose.
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  artFor,
  episodeEvidenceOf,
  episodeLabel,
  pictureIdentification,
  playlistNaming,
  releaseIdentification,
  seasonFiles,
  seasonsAgree,
  shapeOf
} from "../public/domain/media-info.js";
import { playlistRows } from "../public/domain/playlist-groups.js";

const marker = (season, episodes, extra = {}) => ({
  season,
  episodes,
  part: null,
  special: false,
  showHint: "",
  titleHint: "",
  ...extra
});

test("a series is identified from every name known, with the show names the files state", () => {
  const request = releaseIdentification({
    selectionNames: ["Avatar. The Last Airbender 1 - LostFilm.TV [1080p].torrent"],
    contents: {
      name: "Avatar. The Last Airbender 1 - LostFilm.TV [1080p]",
      shape: "series",
      items: [
        { fileIndex: 0, episode: marker(1, [1], { showHint: "Avatar.The.Last.Airbender" }) },
        { fileIndex: 1, episode: marker(1, [2], { showHint: "Avatar.The.Last.Airbender" }) }
      ]
    },
    filesByIndex: new Map()
  });
  assert.equal(request.kindHint, "tv");
  assert.deepEqual(request.names, [
    "Avatar. The Last Airbender 1 - LostFilm.TV [1080p].torrent",
    "Avatar. The Last Airbender 1 - LostFilm.TV [1080p]",
    "Avatar.The.Last.Airbender"
  ]);
});

test("the episode titles sent as evidence are the best-titled season's, without parts or specials", () => {
  const evidence = episodeEvidenceOf([
    { episode: marker(1, [1], { titleHint: "A" }) },
    { episode: marker(2, [1], { titleHint: "B" }) },
    { episode: marker(2, [2], { titleHint: "C" }) },
    { episode: marker(2, [3], { titleHint: "D", part: 1 }) },
    { episode: marker(0, [1], { titleHint: "E", special: true }) }
  ]);
  assert.deepEqual(evidence, { season: 2, titles: ["B", "C"] });
  assert.equal(episodeEvidenceOf([{ episode: marker(1, [1]) }]), null);
});

test("pictures not known to be one work get no identification of the whole release", () => {
  assert.equal(
    releaseIdentification({
      selectionNames: ["Despicable_Me_Trilogy.torrent"],
      contents: { shape: "undetermined", items: [{ fileIndex: 0 }, { fileIndex: 1 }] },
      filesByIndex: new Map()
    }),
    null
  );
});

test("a proxy that states no shape is believed only for a single picture", () => {
  assert.equal(shapeOf({ items: [{ fileIndex: 0 }] }), "single");
  assert.equal(shapeOf({ items: [{ fileIndex: 0 }, { fileIndex: 1 }] }), "undetermined");
});

test("one picture of an undetermined release is asked about by its own name and folder", () => {
  assert.deepEqual(pictureIdentification({ relativePath: "Trilogy/Despicable.Me.2.2013.mkv" }, {}), {
    names: ["Despicable.Me.2.2013", "Trilogy"],
    kindHint: null,
    requireYear: true
  });
  assert.deepEqual(pictureIdentification({ relativePath: "Season_01/s01e01_Pilot.avi" }, { episode: marker(1, [1]) }).names, [
    "s01e01_Pilot"
  ]);
});

test("a series lacking a season the files name is not this release", () => {
  const items = [{ episode: marker(1, [1]) }, { episode: marker(0, [1], { special: true }) }];
  assert.equal(seasonsAgree(items, { seasons: [{ number: 0 }, { number: 1 }] }), true);
  assert.equal(seasonsAgree(items, { seasons: [{ number: 1 }] }), false);
  assert.equal(seasonsAgree([{ episode: marker(null, [3]) }], { seasons: [{ number: 0 }] }), false);
  assert.equal(seasonsAgree([{ episode: null }], { seasons: [] }), true);
});

test("a season request carries every file of that season and nothing of another", () => {
  const work = { seasons: [{ number: 1 }, { number: 2 }] };
  const items = [
    { fileIndex: 3, episode: marker(1, [1], { titleHint: "Pilot" }) },
    { fileIndex: 4, episode: marker(2, [1]) },
    { fileIndex: 5, episode: marker(1, [2]) },
    { fileIndex: 6, episode: null }
  ];
  assert.deepEqual(seasonFiles(items, work, 1).map((file) => file.key), ["3", "5"]);
});

test("a marker without a season belongs to the work's only season", () => {
  const work = { seasons: [{ number: 0 }, { number: 1 }] };
  assert.deepEqual(seasonFiles([{ fileIndex: 0, episode: marker(null, [1]) }], work, 1).map((file) => file.key), ["0"]);
});

test("a matched episode is named by its number in the show and its title", () => {
  assert.equal(episodeLabel({ episodes: [{ number: 2, name: "Murder in the Mews" }], part: null }), "2. Murder in the Mews");
  assert.equal(episodeLabel({ episodes: [{ number: 1, name: "Peril at End House" }], part: 2 }), "1. Peril at End House (part 2)");
  assert.equal(episodeLabel({ episodes: [{ number: 1, name: "A" }, { number: 2, name: "B" }], part: null }), "1–2. A / B");
  assert.equal(episodeLabel({ episodes: [{ number: 3, name: "C" }], part: null }, { withSeason: 4 }), "S4 E3. C");
});

test("the playlist names matched files and their season folder, and keeps the rest", () => {
  const files = [
    { index: 0, relativePath: "Season_01/s01e01.avi", displayName: "Season_01/s01e01" },
    { index: 1, relativePath: "Season_01/s01e02.avi", displayName: "Season_01/s01e02" },
    { index: 2, relativePath: "Season_02/s02e01.avi", displayName: "Season_02/s02e01" },
    { index: 3, relativePath: "Season_02/s02e02.avi", displayName: "Season_02/s02e02" }
  ];
  const state = {
    selection: 1,
    work: { title: "Show" },
    seasons: { 1: "Season 1" },
    episodes: {
      0: { season: 1, episodes: [{ number: 1, name: "Pilot", still: null }], part: null },
      1: { season: 1, episodes: [{ number: 2, name: "Second", still: null }], part: null },
      2: { season: 2, episodes: [{ number: 1, name: "Third", still: null }], part: null }
    },
    pictures: {}
  };
  const rows = playlistRows(files, playlistNaming(state));
  assert.equal(rows[0].label, "Season 1");
  assert.deepEqual(rows[0].files.map((file) => file.label), ["1. Pilot", "2. Second"]);
  assert.equal(rows[1].label, "Season_02", "not every file of the folder is matched, so the folder keeps its name");
  assert.deepEqual(rows[1].files.map((file) => file.label), ["1. Third", "s02e02"]);
});

test("without metadata the playlist is what it was", () => {
  const files = [{ index: 0, relativePath: "a.mkv", displayName: "a" }];
  assert.deepEqual(playlistRows(files, playlistNaming(null)), playlistRows(files));
});

test("the loading picture is the episode's frame, then the work's wide image, then its poster", () => {
  const state = {
    selection: 1,
    work: { backdrop: "backdrop12.jpg", poster: "poster1234.jpg" },
    seasons: {},
    episodes: { 0: { season: 1, episodes: [{ number: 1, name: "", still: "stillframe.jpg" }], part: null } },
    pictures: {}
  };
  assert.equal(artFor(state, 0), "/api/metadata/image/w780/stillframe.jpg");
  assert.equal(artFor(state, 1), "/api/metadata/image/w780/backdrop12.jpg");
  assert.equal(artFor({ ...state, work: { poster: "poster1234.jpg" } }, 1), "/api/metadata/image/w342/poster1234.jpg");
  assert.equal(artFor(null, 0), null);
});

test("an answer for a replaced choice of release changes nothing on screen", async () => {
  const target = new EventTarget();
  Object.assign(target, { readyState: "complete" });
  globalThis.document = target;
  /** @type {Array<{ body: any, resolve: (value: any) => void }>} */
  const pending = [];
  globalThis.fetch = (_url, init) =>
    new Promise((resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      pending.push({ body: JSON.parse(init.body), resolve });
    });
  const { MEDIA_INFO_EVENTS } = await import("../public/shared/events.js");
  await import("../public/components/media-info/media-info.js");

  const published = [];
  target.addEventListener(MEDIA_INFO_EVENTS.CHANGED, (event) => published.push(event.detail));
  const send = (type, detail) => target.dispatchEvent(new CustomEvent(type, { detail }));
  const film = (name) => ({ name, shape: "single", items: [{ fileIndex: 0, episode: null }] });

  send(MEDIA_INFO_EVENTS.SELECTED, { selection: 1, names: ["First.2001.mkv"] });
  send(MEDIA_INFO_EVENTS.CONTENTS, { selection: 1, contents: film("First.2001.mkv"), files: [{ index: 0, relativePath: "First.2001.mkv" }] });
  const firstAnswer = pending.find((request) => request.body.names.includes("First.2001.mkv") && request.body.names.length > 1);
  assert.ok(firstAnswer, "the release was identified once its contents arrived");

  send(MEDIA_INFO_EVENTS.SELECTED, { selection: 2, names: ["Second.2002.mkv"] });
  firstAnswer.resolve(Response.json({ status: "identified", work: { kind: "movie", tmdbId: 1, title: "First" } }));
  await new Promise((resolve) => setImmediate(resolve));

  assert.ok(published.every((state) => state === null || state.work?.title !== "First"));
  assert.equal(published.at(-1), null);
});


test("subtitle metadata retries only after not-found and only once", async () => {
  const target = new EventTarget();
  globalThis.document = target;
  const pending = [];
  globalThis.fetch = (_url, init) => new Promise(resolve => pending.push({ body: JSON.parse(init.body), resolve }));
  const { MediaInfoController } = await import("../public/components/media-info/media-info.js");
  const { MEDIA_INFO_EVENTS } = await import("../public/shared/events.js");
  new MediaInfoController();
  const send = (type, detail) => target.dispatchEvent(new CustomEvent(type, { detail }));
  send(MEDIA_INFO_EVENTS.SELECTED, { selection: 1, names: ["Princessa.Mononoke.mkv"] });
  send(MEDIA_INFO_EVENTS.CONTENTS, { selection: 1, contents: { name: "Princessa.Mononoke.mkv", shape: "single", items: [{ fileIndex: 0, episode: null }] }, files: [{ index: 0, relativePath: "Princessa.Mononoke.mkv" }] });
  const vtt = `WEBVTT\n\nNOTE TORRENT-TV-METADATA\n${JSON.stringify({ titles: ["Princess Mononoke"], years: [1997] })}\n\n`;
  send(MEDIA_INFO_EVENTS.SUBTITLE_EVIDENCE, { fileIndex: 0, vtt });
  assert.equal(pending.length, 2, "subtitle arrival does not race the first identification");
  pending[1].resolve(Response.json({ status: "not-found" }));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(pending.length, 3);
  assert.deepEqual(pending[2].body.subtitleEvidence, { titles: ["Princess Mononoke"], years: [1997] });
  send(MEDIA_INFO_EVENTS.SUBTITLE_EVIDENCE, { fileIndex: 0, vtt });
  assert.equal(pending.length, 3);
  send(MEDIA_INFO_EVENTS.SELECTED, { selection: 2, names: ["Another.2000.mkv"] });
  pending[2].resolve(Response.json({ status: "not-found" }));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(pending.length, 4, "a late answer cannot retry a new selection with old evidence");
});
