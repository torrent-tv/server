import test from "node:test";
import assert from "node:assert/strict";
import { EVIDENCE, MetadataProvider, STAGE } from "../services/metadata/MetadataProvider.js";
import { MetadataRegistry } from "../services/metadata/MetadataRegistry.js";
import { TmdbProvider } from "../services/metadata/TmdbProvider.js";
import { AniListProvider } from "../services/metadata/AniListProvider.js";
import { ContainerMetadata, isPlainTitle, readContainerFacts } from "../services/metadata/ContainerMetadata.js";
import { FIELD_PRIORITY, mergeRecords, normalizeWork } from "../services/metadata/normalize-work.js";

const work = { tmdbId: 7, kind: "tv", title: "Example", originalTitle: "例", year: null, seasons: [{ number: 1 }], images: [] };
const offline = { fetch: async () => { throw new Error("offline"); }, gate: { run: task => task(), pause() {} } };

function registry({ answer = { status: "identified", work }, seen = [] } = {}) {
  const tmdb = new TmdbProvider({ identify: async request => { seen.push(request); return answer; }, episodes: async request => ({ status: "ok", request }) });
  return new MetadataRegistry({ providers: [new ContainerMetadata(), new AniListProvider(offline), tmdb] });
}

test("a provider takes only the evidence it states, and implements what it is asked", async () => {
  const provider = new MetadataProvider({ name: "x", stage: STAGE.primary, takes: [EVIDENCE.fingerprint] });
  assert.equal(provider.accepts({ names: ["a"] }), false);
  assert.equal(provider.accepts({ names: ["a"], fingerprint: { hash: "ab", size: 1 } }), true);
  await assert.rejects(provider.identify({}), /must be implemented/);
  assert.throws(() => provider.fields({}), /must be implemented/);
  assert.equal(await provider.lastResort({}), null);
  assert.equal(provider.evidenceFrom({}), null);
});

test("each field has its own order of sources", () => {
  const tmdb = { source: "tmdb", record: {}, fields: { title: "From TMDB", year: undefined, isAnime: undefined } };
  const anilist = { source: "anilist", record: {}, fields: { title: "From AniList", year: 2001, isAnime: true } };
  const merged = mergeRecords([tmdb, anilist]).normalized;
  assert.equal(merged.title, "From TMDB");
  assert.equal(merged.year, 2001);
  assert.equal(merged.isAnime, true);
  assert.deepEqual([merged.provenance.title, merged.provenance.year, merged.provenance.isAnime], ["tmdb", "anilist", "anilist"]);
  assert.deepEqual(FIELD_PRIORITY.isAnime, ["anilist", "tmdb"]);
  assert.equal(mergeRecords([]).normalized.provenance.title, null);
  assert.deepEqual(normalizeWork({ tmdbId: 1, kind: "movie", title: "A" }).normalized.kind, "movie");
});

test("a container title that is only a release name is not a title", () => {
  assert.equal(isPlainTitle("Spirited Away"), true);
  assert.equal(isPlainTitle("Spirited.Away.2001.1080p.BluRay.x264-GRP"), false);
  const fields = new ContainerMetadata().fields({ title: "Spirited.Away.2001.1080p.BluRay.x264-GRP", originalTitle: "千と千尋の神隠し", year: 2001 });
  assert.equal(fields.title, undefined);
  assert.equal(fields.originalTitle, "千と千尋の神隠し");
  assert.equal(fields.year, 2001);
});

test("what a container states is checked and bounded before it is used", () => {
  const facts = readContainerFacts({ title: "  A  ", year: 3000, season: -1, episode: 3, externalIds: { imdb: "tt123", tmdb: "5", anilist: 9 }, genres: ["Drama", 4, "Comedy"] });
  assert.equal(facts.title, "A");
  assert.equal(facts.year, undefined);
  assert.equal(facts.season, undefined);
  assert.equal(facts.episode, 3);
  assert.deepEqual(facts.externalIds, { imdb: "tt123", anilist: 9 });
  assert.deepEqual(facts.genres, ["Drama", "Comedy"]);
  assert.equal(readContainerFacts("text"), null);
  assert.equal(readContainerFacts({ title: "x".repeat(1000) }).title.length, 300);
});

test("the container is evidence for the others: its names and ids reach the search", async () => {
  const seen = [];
  const answer = await registry({ seen }).identify({ names: ["Release.Name.1080p"],
    container: { title: "Release.Name.1080p.WEB-DL", originalTitle: "Original Name", season: 2, episode: 5, episodeTitle: "Pilot", externalIds: { imdb: "tt0000001" } } });
  assert.equal(answer.status, "identified");
  assert.deepEqual(seen[0].names, ["Release.Name.1080p", "Original Name"]);
  assert.deepEqual([seen[0].season, seen[0].episode, seen[0].episodeTitle], [2, 5, "Pilot"]);
  assert.deepEqual(seen[0].externalIds, { imdb: "tt0000001" });
});

test("the container is also a source: it fills a field the databases leave empty", async () => {
  const answer = await registry().identify({ names: ["Example"], container: { year: 1999, season: 1 } });
  assert.equal(answer.work.normalized.year, 1999);
  assert.equal(answer.work.normalized.provenance.year, "container");
  assert.equal(answer.work.normalized.provenance.title, "tmdb");
  assert.equal(answer.work.sources.container.year, 1999);
});

test("without container evidence the container is not consulted and the answer is unchanged", async () => {
  const answer = await registry().identify({ names: ["Example"] });
  assert.equal(answer.work.sources.container, undefined);
  assert.equal(answer.work.normalized.year, null);
  assert.equal(answer.work.normalized.provenance.year, null);
});

test("an answer that is not an identity carries no records", async () => {
  const answer = await registry({ answer: { status: "ambiguous", candidates: [work] } }).identify({ names: ["Example"] });
  assert.deepEqual(answer, { status: "ambiguous", candidates: [work] });
});

test("episodes go to the first source that answers them, and without one the answer is unavailable", async () => {
  assert.equal((await registry().episodes({ tmdbId: 7 })).status, "ok");
  assert.deepEqual(await new MetadataRegistry({ providers: [new ContainerMetadata()] }).episodes({}), { status: "unavailable" });
});