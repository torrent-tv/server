/**
 * @file What a file states about its work (meta#139): a lookup by the ids it
 * states, the record the server keeps by infohash and file index, the route
 * that keeps and reads it, and how the page fills its empty fields from it
 * without replacing anything already shown.
 *
 * No request leaves this machine: every provider here is a function.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { resolveObjectURL } from "node:buffer";
import { MetadataService } from "../services/metadata/MetadataService.js";
import { MetadataCache } from "../services/metadata/MetadataCache.js";
import { SharedFetches } from "../services/metadata/SharedFetches.js";
import { MetadataUnavailableError } from "../services/metadata/RequestGate.js";
import { ContainerRecords, fileOf } from "../services/metadata/ContainerRecords.js";
import { handleApiMetadataIdentifyPost } from "../routes/api/metadata/identify/post.js";
import { handleApiMetadataContainerPost } from "../routes/api/metadata/container/post.js";
import { artFor, containerEpisode, containerEvidence, playerArt, systemArtwork, workFor } from "../public/domain/media-info.js";

// The component starts one controller of its own when it is first loaded; it is
// loaded here, over a document no check uses, so each check's controller is the only one listening.
globalThis.document = new EventTarget();
await import("../public/components/media-info/media-info.js");

const INFO_HASH = "0123456789abcdef0123456789abcdef01234567";

/** A TMDB that answers lookups from tables and counts what it is asked. */
function fakeSource({ found = {}, missing = new Set() } = {}) {
  const asked = [];
  return {
    asked,
    async find(id, source) {
      asked.push(`find|${source}|${id}`);
      return found[`${source}|${id}`] ?? { movie: [], tv: [] };
    },
    async work(kind, id) {
      asked.push(`work|${kind}|${id}`);
      if (missing.has(`${kind}|${id}`)) throw new MetadataUnavailableError("the provider answered 404");
      return { kind, tmdbId: id, title: "T", originalTitle: "T", year: 2000, overview: "", poster: null, backdrop: null, seasons: [] };
    },
    async search() {
      asked.push("search");
      return { results: [], totalPages: 0 };
    }
  };
}

const service = (source) => new MetadataService({
  source,
  cache: new MetadataCache({ budgetBytes: 1 << 20, maxEntryBytes: 1 << 16 }),
  fetches: new SharedFetches({ waiterLimit: 16 })
});

test("a TMDB id is the work itself: no find, no search", async () => {
  const source = fakeSource();
  const answer = await service(source).identifyById({ externalIds: { tmdb: { kind: "tv", id: 1437 } }, language: "en-US" });
  assert.equal(answer.status, "identified");
  assert.equal(answer.work.tmdbId, 1437);
  assert.equal(answer.work.identification, "external-id");
  assert.deepEqual(source.asked, ["work|tv|1437"]);
});

test("an IMDb id is found through TMDB, and an episode's id names its series", async () => {
  const source = fakeSource({ found: { "imdb_id|tt0579539": { movie: [], tv: [1437] } } });
  const answer = await service(source).identifyById({ externalIds: { imdb: "tt0579539" }, language: "en-US" });
  assert.equal(answer.status, "identified");
  assert.equal(answer.work.kind, "tv");
  assert.deepEqual(source.asked, ["find|imdb_id|tt0579539", "work|tv|1437"]);
});

test("an id that names nothing, or more than one work, decides nothing", async () => {
  const two = fakeSource({ found: { "imdb_id|tt0000001": { movie: [5], tv: [6] } } });
  assert.deepEqual(await service(two).identifyById({ externalIds: { imdb: "tt0000001" }, language: "en-US" }), { status: "not-found" });
  assert.deepEqual(await service(fakeSource()).identifyById({ externalIds: { tvdb: 81189 }, language: "en-US" }), { status: "not-found" });
  const gone = fakeSource({ missing: new Set(["movie|99"]) });
  assert.deepEqual(await service(gone).identifyById({ externalIds: { tmdb: { kind: "movie", id: 99 } }, language: "en-US" }), { status: "not-found" });
  assert.deepEqual(await service(null).identifyById({ externalIds: { imdb: "tt0000001" }, language: "en-US" }), { status: "unavailable" });
});

test("a record is kept by infohash and file index, in the checked shape only", async () => {
  const records = new ContainerRecords({ cache: new MetadataCache({ budgetBytes: 1 << 20, maxEntryBytes: 1 << 14 }) });
  await records.set({ infoHash: INFO_HASH, fileIndex: 2 }, { title: "Moana", year: 2016, junk: "x".repeat(10) });
  const kept = await records.get({ infoHash: INFO_HASH, fileIndex: 2 });
  assert.equal(kept.title, "Moana");
  assert.equal(kept.year, 2016);
  assert.equal(kept.junk, undefined);
  assert.equal(await records.get({ infoHash: INFO_HASH, fileIndex: 3 }), undefined);
  assert.deepEqual(fileOf({ infoHash: INFO_HASH.toUpperCase(), fileIndex: 0 }), { infoHash: INFO_HASH, fileIndex: 0 });
  assert.equal(fileOf({ infoHash: "abc", fileIndex: 0 }), null);
  assert.equal(fileOf({ infoHash: INFO_HASH, fileIndex: -1 }), null);
});

test("the route keeps what a file states and gives it to the next request for the same file", async () => {
  const records = new ContainerRecords({ cache: new MetadataCache({ budgetBytes: 1 << 20, maxEntryBytes: 1 << 14 }) });
  const seen = [];
  const metadata = { identify: async (request) => { seen.push(request); return { status: "not-found" }; } };
  const ask = async (body) => {
    const reply = { raw: { once() {} }, code(status) { reply.status = status; return reply; }, send(payload) { reply.body = payload; return reply; } };
    await handleApiMetadataIdentifyPost({ body, id: "r" }, reply, { metadata, containerRecords: records });
    return reply;
  };
  const source = { infoHash: INFO_HASH, fileIndex: 1 };
  const first = await ask({ names: ["Avatar 1 - LostFilm.TV"], kindHint: null, language: "en-US", source, container: { seriesTitle: "Аватар", season: 1, episode: 1, episodeTitle: "Аанг" } });
  assert.equal(first.status, undefined);
  assert.equal(seen[0].container.episodeTitle, "Аанг");
  const second = await ask({ names: ["Avatar 1 - LostFilm.TV"], kindHint: null, language: "en-US", source });
  assert.equal(seen[1].container.episodeTitle, "Аанг", "the next viewer of the file is identified with what was kept");
  assert.equal(second.body.container.seriesTitle, "Аватар");
  assert.equal((await ask({ names: ["x"], kindHint: null, language: "en-US", source: { infoHash: "nope", fileIndex: 1 } })).status, 400);
  assert.equal((await ask({ names: ["x"], kindHint: null, language: "en-US", container: [] })).status, 400);
});

test("the page sends only what identification reads", () => {
  assert.deepEqual(containerEvidence({ title: "A", trackTitles: ["RUS"], chapterTitles: ["x"], cover: { type: "image/jpeg" }, outsideEdges: false, year: null }), { title: "A" });
  assert.equal(containerEvidence({ trackTitles: ["RUS"] }), null);
});

test("an episode the file states fills only when it states its title and a number", () => {
  assert.deepEqual(containerEpisode({ season: 1, episode: 2, episodeTitle: "Аанг" }, null),
    { source: "container", season: 1, episodes: [{ number: 2, name: "Аанг", still: null }], part: null });
  assert.equal(containerEpisode({ episodeTitle: "Аанг" }, { season: 3, episodes: [4] }).episodes[0].number, 4);
  assert.equal(containerEpisode({ season: 1, episode: 2 }, null), null);
  assert.equal(containerEpisode({ episodeTitle: "Аанг" }, null), null);
});

test("what a file states fills the work's empty fields and replaces none", () => {
  const state = { work: { normalized: { title: "Moana", year: null, overview: "", poster: null } }, containers: { 0: { year: 2016, description: "An ocean." } } };
  assert.deepEqual([workFor(state, 0).year, workFor(state, 0).overview], [2016, "An ocean."]);
  const stated = { work: { normalized: { title: "Moana", year: 2026, overview: "Sea." } }, containers: { 0: { year: 2016, description: "An ocean." } } };
  assert.deepEqual([workFor(stated, 0).year, workFor(stated, 0).overview], [2026, "Sea."]);
  assert.equal(workFor({ work: null, containers: { 0: { year: 2016 } } }, 0), null, "with no work the release's own name stays");
});

test("the file's own cover is shown only where no poster is", () => {
  const cover = { coverUrl: "blob:https://webauth.courses/1", coverType: "image/png" };
  const bare = { work: null, containers: { 0: cover } };
  assert.equal(artFor(bare, 0), cover.coverUrl);
  assert.deepEqual(playerArt(bare, 0, 1280, 720), { url: cover.coverUrl, width: null, height: null });
  assert.deepEqual(systemArtwork(bare, 0), [{ src: cover.coverUrl, sizes: "", type: "image/png" }]);
  const poster = { work: { normalized: { poster: "abcdefgh.jpg", images: [] } }, containers: { 0: cover } };
  assert.equal(artFor(poster, 0), "/api/metadata/image/w342/abcdefgh.jpg");
  assert.notEqual(playerArt(poster, 0, 1280, 720).url, cover.coverUrl);
  assert.notEqual(systemArtwork(poster, 0)[0].src, cover.coverUrl);
});

test("what the opened file states asks again for a release the names did not establish, and the server keeps it", async () => {
  const target = new EventTarget();
  globalThis.document = target;
  const pending = [];
  globalThis.fetch = (_url, init) => new Promise((resolve) => pending.push({ body: JSON.parse(init.body), resolve }));
  const { MediaInfoController } = await import("../public/components/media-info/media-info.js");
  const { MEDIA_INFO_EVENTS } = await import("../public/shared/events.js");
  new MediaInfoController();
  const send = (type, detail) => target.dispatchEvent(new CustomEvent(type, { detail }));
  const published = [];
  target.addEventListener(MEDIA_INFO_EVENTS.CHANGED, (event) => published.push(event.detail));
  send(MEDIA_INFO_EVENTS.SELECTED, { selection: 1, names: ["Mortal.Kombat.1080p.mkv"] });
  send(MEDIA_INFO_EVENTS.CONTENTS, { selection: 1, contents: { name: "Mortal.Kombat.1080p.mkv", infoHash: INFO_HASH, shape: "single", items: [{ fileIndex: 0 }] },
    files: [{ index: 0, relativePath: "Mortal.Kombat.1080p.mkv" }] });
  assert.deepEqual(pending[1].body.source, { infoHash: INFO_HASH, fileIndex: 0 }, "the file is named, so the server can give what it kept");
  pending[1].resolve(Response.json({ status: "not-found" }));
  await new Promise((resolve) => setImmediate(resolve));
  const container = { segmentTitle: "Mortal.Kombat.2021.BDRip-1080p", trackTitles: ["RUS"], cover: null };
  send(MEDIA_INFO_EVENTS.CONTAINER, { selection: 1, fileIndex: 0, container });
  assert.equal(pending.length, 3);
  assert.deepEqual(pending[2].body.container, { segmentTitle: "Mortal.Kombat.2021.BDRip-1080p" });
  send(MEDIA_INFO_EVENTS.CONTAINER, { selection: 1, fileIndex: 0, container });
  assert.equal(pending.length, 3, "a file's statements ask again once");
  assert.equal(published.at(-1).containers[0].segmentTitle, "Mortal.Kombat.2021.BDRip-1080p");
});

test("an episode title the file states fills an episode no provider named, and never replaces one shown", async () => {
  const target = new EventTarget();
  globalThis.document = target;
  const pending = [];
  globalThis.fetch = (url, init) => new Promise((resolve) => pending.push({ url, body: JSON.parse(init.body), resolve }));
  const { MediaInfoController } = await import("../public/components/media-info/media-info.js");
  const { MEDIA_INFO_EVENTS } = await import("../public/shared/events.js");
  new MediaInfoController();
  const send = (type, detail) => target.dispatchEvent(new CustomEvent(type, { detail }));
  const published = [];
  target.addEventListener(MEDIA_INFO_EVENTS.CHANGED, (event) => published.push(event.detail));
  const logged = [];
  const info = console.info;
  console.info = (line) => logged.push(line);
  try {
    const episode = (number) => ({ season: 1, episodes: [number], part: null, special: false, showHint: "", titleHint: "" });
    send(MEDIA_INFO_EVENTS.SELECTED, { selection: 1, names: ["Avatar 1 - LostFilm.TV"] });
    send(MEDIA_INFO_EVENTS.CONTENTS, { selection: 1, contents: { name: "Avatar 1 - LostFilm.TV", infoHash: INFO_HASH, shape: "series",
      items: [{ fileIndex: 0, episode: episode(1) }, { fileIndex: 1, episode: episode(2) }] },
      files: [{ index: 0, relativePath: "a/E01.mp4" }, { index: 1, relativePath: "a/E02.mp4" }] });
    send(MEDIA_INFO_EVENTS.CONTAINER, { selection: 1, fileIndex: 0, container: { season: 1, episode: 1, episodeTitle: "Аанг" } });
    assert.equal(published.at(-1).episodes[0].episodes[0].name, "Аанг");
    assert.equal(pending.length, 3, "a series not yet identified is asked again with what its episode states");
    assert.equal(pending[2].body.container.episodeTitle, "Аанг");
    pending[2].resolve(Response.json({ status: "identified", work: { kind: "tv", tmdbId: 246, title: "Avatar", seasons: [{ number: 1 }] } }));
    await new Promise((resolve) => setImmediate(resolve));
    send(MEDIA_INFO_EVENTS.WANT_FILES, { fileIndexes: [0] });
    const season = pending.find((request) => request.url === "/api/metadata/episodes");
    season.resolve(Response.json({ status: "matched-season", season: { number: 1, name: "Book One" }, files: [
      { key: "0", status: "matched", episodes: [{ number: 1, name: "The Boy in the Iceberg", still: null }] },
      { key: "1", status: "matched", episodes: [{ number: 2, name: "The Avatar Returns", still: null }] }] }));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(published.at(-1).episodes[0].episodes[0].name, "Аанг", "the title already shown stays");
    assert.equal(published.at(-1).episodes[1].episodes[0].name, "The Avatar Returns");
    assert.ok(logged.some((line) => /file 0: tmdb states another episode title/u.test(line)));
  } finally {
    console.info = info;
  }
});

test("a cover the file carries is published as a blob address and revoked with the choice", async () => {
  const target = new EventTarget();
  globalThis.document = target;
  globalThis.fetch = () => new Promise(() => {});
  const { MediaInfoController } = await import("../public/components/media-info/media-info.js");
  const { MEDIA_INFO_EVENTS } = await import("../public/shared/events.js");
  new MediaInfoController();
  const send = (type, detail) => target.dispatchEvent(new CustomEvent(type, { detail }));
  const published = [];
  target.addEventListener(MEDIA_INFO_EVENTS.CHANGED, (event) => published.push(event.detail));
  send(MEDIA_INFO_EVENTS.SELECTED, { selection: 1, names: ["Film.mp4"] });
  send(MEDIA_INFO_EVENTS.CONTENTS, { selection: 1, contents: { name: "Film.mp4", shape: "single", items: [{ fileIndex: 0 }] }, files: [{ index: 0, relativePath: "Film.mp4" }] });
  send(MEDIA_INFO_EVENTS.CONTAINER_COVER, { selection: 1, fileIndex: 0, cover: new Blob([new Uint8Array([0xff, 0xd8, 0xff])], { type: "image/jpeg" }) });
  const { coverUrl, coverType } = published.at(-1).containers[0];
  assert.match(coverUrl, /^blob:/u);
  assert.ok(resolveObjectURL(coverUrl));
  assert.equal(coverType, "image/jpeg");
  send(MEDIA_INFO_EVENTS.SELECTED, { selection: 2, names: ["Other.mp4"] });
  assert.equal(resolveObjectURL(coverUrl), undefined, "the next choice frees the last one's cover");
});

test("a record that cannot be kept or read costs only the record", async () => {
  const broken = new ContainerRecords({ cache: { get: async () => { throw new Error("disk"); }, set: async () => { throw new Error("disk"); } } });
  const warn = console.warn;
  console.warn = () => {};
  try {
    await broken.set({ infoHash: INFO_HASH, fileIndex: 0 }, { title: "A" });
    assert.equal(await broken.get({ infoHash: INFO_HASH, fileIndex: 0 }), undefined);
  } finally {
    console.warn = warn;
  }
});

test("what a file states is kept even when the work was established without it", async () => {
  const records = new ContainerRecords({ cache: new MetadataCache({ budgetBytes: 1 << 20, maxEntryBytes: 1 << 14 }) });
  const ask = async (body) => {
    const reply = { code(status) { reply.status = status; return reply; }, send(payload) { reply.body = payload; return reply; } };
    await handleApiMetadataContainerPost({ body }, reply, { containerRecords: records });
    return reply;
  };
  assert.equal((await ask({ source: { infoHash: INFO_HASH, fileIndex: 0 }, container: { segmentTitle: "Mortal.Kombat.2021.BDRip-1080p" } })).status, 204);
  assert.equal((await records.get({ infoHash: INFO_HASH, fileIndex: 0 })).segmentTitle, "Mortal.Kombat.2021.BDRip-1080p");
  assert.equal((await ask({ container: { title: "A" } })).status, 400);
  assert.equal((await ask({ source: { infoHash: INFO_HASH, fileIndex: 0 }, container: "x" })).status, 400);
});

test("the page tells the server to keep what a file states when its work is already established", async () => {
  const target = new EventTarget();
  globalThis.document = target;
  const pending = [];
  globalThis.fetch = (url, init) => new Promise((resolve) => pending.push({ url, body: JSON.parse(init.body), resolve }));
  const { MediaInfoController } = await import("../public/components/media-info/media-info.js");
  const { MEDIA_INFO_EVENTS } = await import("../public/shared/events.js");
  new MediaInfoController();
  const send = (type, detail) => target.dispatchEvent(new CustomEvent(type, { detail }));
  send(MEDIA_INFO_EVENTS.SELECTED, { selection: 1, names: ["Mortal.Kombat.1080p.mkv"] });
  send(MEDIA_INFO_EVENTS.CONTENTS, { selection: 1, contents: { name: "Mortal.Kombat.1080p.mkv", infoHash: INFO_HASH, shape: "single", items: [{ fileIndex: 0 }] },
    files: [{ index: 0, relativePath: "Mortal.Kombat.1080p.mkv" }] });
  pending[1].resolve(Response.json({ status: "identified", work: { kind: "movie", tmdbId: 460465, title: "Mortal Kombat", year: 2021 } }));
  await new Promise((resolve) => setImmediate(resolve));
  send(MEDIA_INFO_EVENTS.CONTAINER, { selection: 1, fileIndex: 0, container: { segmentTitle: "Mortal.Kombat.2021.BDRip-1080p", trackTitles: ["RUS"] } });
  assert.equal(pending.length, 3);
  assert.equal(pending[2].url, "/api/metadata/container");
  assert.deepEqual(pending[2].body, { source: { infoHash: INFO_HASH, fileIndex: 0 }, container: { segmentTitle: "Mortal.Kombat.2021.BDRip-1080p" } });
});
