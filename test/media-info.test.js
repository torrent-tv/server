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
    kindHint: null
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

test("probed duration and audio refine a choice among several works and ignore old selections", async () => {
  const target = new EventTarget();
  globalThis.document = target;
  const pending = [];
  globalThis.fetch = (_url, init) => new Promise(resolve => pending.push({ body: JSON.parse(init.body), resolve }));
  const { MediaInfoController } = await import("../public/components/media-info/media-info.js");
  const { MEDIA_INFO_EVENTS, APP_EVENTS } = await import("../public/shared/events.js");
  new MediaInfoController();
  const send = (type, detail) => target.dispatchEvent(new CustomEvent(type, { detail }));
  const published = [];
  target.addEventListener(MEDIA_INFO_EVENTS.CHANGED, event => published.push(event.detail));
  send(MEDIA_INFO_EVENTS.SELECTED, { selection: 1, names: ["Title.mkv"] });
  send(MEDIA_INFO_EVENTS.CONTENTS, { selection: 1, contents: { name: "Title.mkv", shape: "single", items: [{ fileIndex: 0 }] }, files: [{ index: 0, relativePath: "Title.mkv" }] });
  pending[1].resolve(Response.json({ status: "identified", work: { kind: "movie", tmdbId: 2, identification: "scored" } }));
  await new Promise(resolve => setImmediate(resolve));
  send(MEDIA_INFO_EVENTS.PROBED, { selection: 1, fileIndex: 0, durationSeconds: 7200, audioLanguages: ["ja"] });
  assert.equal(pending.length, 3);
  assert.equal(pending[2].body.durationSeconds, 7200);
  assert.deepEqual(pending[2].body.audioLanguages, ["ja"]);
  send(MEDIA_INFO_EVENTS.PROBED, { selection: 1, fileIndex: 0, durationSeconds: 7200 });
  assert.equal(pending.length, 3);
  send(APP_EVENTS.RESET_TO_PICKER);
  pending[2].resolve(Response.json({ status: "identified", work: { kind: "movie", tmdbId: 1 } }));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(published.at(-1), null);
  send(MEDIA_INFO_EVENTS.PROBED, { selection: 1, fileIndex: 0, durationSeconds: 7200 });
  assert.equal(pending.length, 3);
});

test("the category a torrent states is sent with every request, and the hash asks again once for a release that was not found", async () => {
  const target = new EventTarget();
  globalThis.document = target;
  const pending = [];
  globalThis.fetch = (_url, init) => new Promise(resolve => pending.push({ body: JSON.parse(init.body), resolve }));
  const { MediaInfoController } = await import("../public/components/media-info/media-info.js");
  const { MEDIA_INFO_EVENTS } = await import("../public/shared/events.js");
  new MediaInfoController();
  const send = (type, detail) => target.dispatchEvent(new CustomEvent(type, { detail }));
  send(MEDIA_INFO_EVENTS.SELECTED, { selection: 1, names: ["Scene.Name.2025.mkv"], category: "adult" });
  send(MEDIA_INFO_EVENTS.CONTENTS, { selection: 1, contents: { name: "Scene.Name.2025.mkv", shape: "single", items: [{ fileIndex: 0 }] }, files: [{ index: 0, relativePath: "Scene.Name.2025.mkv" }] });
  assert.equal(pending.length, 2);
  assert.ok(pending.every(request => request.body.category === "adult" && request.body.fingerprint === undefined));
  pending[1].resolve(Response.json({ status: "not-found" }));
  await new Promise(resolve => setImmediate(resolve));
  const fingerprint = { hash: "8e245d9679d31e12", size: 12909756 };
  send(MEDIA_INFO_EVENTS.FINGERPRINT, { selection: 1, fileIndex: 0, fingerprint });
  assert.equal(pending.length, 3);
  assert.deepEqual(pending[2].body.fingerprint, fingerprint);
  assert.equal(pending[2].body.category, "adult");
  send(MEDIA_INFO_EVENTS.FINGERPRINT, { selection: 1, fileIndex: 0, fingerprint });
  assert.equal(pending.length, 3, "a hash is asked about once");
  send(MEDIA_INFO_EVENTS.SELECTED, { selection: 2, names: ["Other.mkv"] });
  assert.equal(pending[3].body.category, undefined, "the next choice does not inherit the category");
});

test("a release that is already identified is not asked again when its hash arrives", async () => {
  const target = new EventTarget();
  globalThis.document = target;
  const pending = [];
  globalThis.fetch = (_url, init) => new Promise(resolve => pending.push({ body: JSON.parse(init.body), resolve }));
  const { MediaInfoController } = await import("../public/components/media-info/media-info.js");
  const { MEDIA_INFO_EVENTS } = await import("../public/shared/events.js");
  new MediaInfoController();
  const send = (type, detail) => target.dispatchEvent(new CustomEvent(type, { detail }));
  send(MEDIA_INFO_EVENTS.SELECTED, { selection: 1, names: ["Known.Film.1999.mkv"] });
  send(MEDIA_INFO_EVENTS.CONTENTS, { selection: 1, contents: { name: "Known.Film.1999.mkv", shape: "single", items: [{ fileIndex: 0 }] }, files: [{ index: 0, relativePath: "Known.Film.1999.mkv" }] });
  pending[1].resolve(Response.json({ status: "identified", work: { kind: "movie", tmdbId: 3, title: "Known Film" } }));
  await new Promise(resolve => setImmediate(resolve));
  send(MEDIA_INFO_EVENTS.FINGERPRINT, { selection: 1, fileIndex: 0, fingerprint: { hash: "8e245d9679d31e12", size: 1 } });
  assert.equal(pending.length, 2);
});

test("the address names the work of the open file: its database, number, kind, category and episode", async () => {
  const { addressRecord } = await import("../public/domain/media-info.js");
  const work = { sources: { tmdb: { kind: "tv", tmdbId: 67075, anime: true }, anilist: { id: 21662, format: "TV" } }, normalized: { isAnime: true } };
  const state = { work, episodes: { 27: { source: "tmdb", season: 1, episodes: [{ number: 3, name: "Army of Ours: Sortie at Dawn", still: null }] } } };
  assert.deepEqual(addressRecord(state, 27), { type: "tmdb", id: "67075", kind: "tv", category: "anime", season: 1, episode: 3 });
  // A picture of a pack names its own work, not the release's.
  const pack = { work: null, pictures: { 4: { sources: { tmdb: { kind: "movie", tmdbId: 1368 } } } } };
  assert.deepEqual(addressRecord(pack, 4), { type: "tmdb", id: "1368", kind: "movie", category: null, season: null, episode: null });
  assert.equal(addressRecord(pack, 5), null);
  // Only AniList knows it.
  assert.equal(addressRecord({ work: { sources: { anilist: { id: 21662, format: "MOVIE" } } } }, 0).type, "anilist");
  assert.equal(addressRecord(null, 0), null);
});

test("episode numbers of a release are evidence, with no season where the name states none", async () => {
  const { episodeNumbersOf } = await import("../public/domain/media-info.js");
  const items = [
    { episode: { season: null, episodes: [1] } },
    { episode: { season: 1, episodes: [2, 3] } },
    { episode: { season: 0, episodes: [1], special: true } },
    { episode: null }
  ];
  assert.deepEqual(episodeNumbersOf(items), [{ season: null, episode: 1 }, { season: 1, episode: 2 }, { season: 1, episode: 3 }]);
});

test("the work the address names, and when the torrent was made, go with every request", async () => {
  const target = new EventTarget();
  globalThis.document = target;
  const pending = [];
  globalThis.fetch = (_url, init) => new Promise(resolve => pending.push({ body: JSON.parse(init.body), resolve }));
  const { MediaInfoController } = await import("../public/components/media-info/media-info.js");
  const { MEDIA_INFO_EVENTS } = await import("../public/shared/events.js");
  new MediaInfoController();
  const send = (type, detail) => target.dispatchEvent(new CustomEvent(type, { detail }));
  const record = { type: "tmdb", id: "67075", kind: "tv", category: "anime", season: 1, episode: 1 };
  send(MEDIA_INFO_EVENTS.SELECTED, { selection: 1, names: ["Drifters"], createdAt: 1482921955, record, recordFileIndex: 27 });
  send(MEDIA_INFO_EVENTS.CONTENTS, { selection: 1, contents: { name: "Drifters", shape: "series", items: [
    { fileIndex: 27, episode: { season: null, episodes: [1] } }, { fileIndex: 28, episode: { season: null, episodes: [2] } }
  ] }, files: [{ index: 27, relativePath: "Drifters/[HorribleSubs] Drifters - 01 [1080p].mkv" }, { index: 28, relativePath: "Drifters/[HorribleSubs] Drifters - 02 [1080p].mkv" }] });
  assert.equal(pending.length, 2);
  for (const { body } of pending) {
    assert.deepEqual(body.record, { type: "tmdb", id: "67075", kind: "tv" });
    assert.equal(body.torrentCreatedAt, 1482921955);
  }
  assert.deepEqual(pending[1].body.episodeNumbers, [{ season: null, episode: 1 }, { season: null, episode: 2 }]);
});
