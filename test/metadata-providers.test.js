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
  const fields = new ContainerMetadata().fields({ title: "Spirited.Away.2001.1080p.BluRay.x264-GRP", otherTitles: ["千と千尋の神隠し"], year: 2001, description: "A girl." });
  assert.equal(fields.title, "千と千尋の神隠し");
  assert.equal(fields.year, 2001);
  assert.equal(fields.overview, "A girl.");
  assert.equal(fields.kind, undefined);
  assert.equal(new ContainerMetadata().fields({ season: 1 }).kind, "series");
});

test("what a container states is checked and bounded before it is used", () => {
  const facts = readContainerFacts({ title: "  A  ", year: 3000, season: -1, episode: 3,
    externalIds: { imdb: "tt0123456", tmdb: { kind: "tv", id: 5 }, tvdb: 81189 }, genres: ["Drama", 4, "Comedy"] });
  assert.equal(facts.title, "A");
  assert.equal(facts.year, undefined);
  assert.equal(facts.season, undefined);
  assert.equal(facts.episode, 3);
  assert.deepEqual(facts.externalIds, { imdb: "tt0123456", tmdb: { kind: "tv", id: 5 }, tvdb: 81189 });
  assert.deepEqual(facts.genres, ["Drama", "Comedy"]);
  assert.deepEqual(readContainerFacts({ externalIds: { imdb: "tt123", tmdb: "movie/5", tvdb: "x" } }).externalIds, {});
  assert.equal(readContainerFacts("text"), null);
  assert.equal(readContainerFacts([]), null);
  assert.equal(readContainerFacts({ title: "x".repeat(1000) }).title.length, 300);
  assert.equal(readContainerFacts({ description: "x".repeat(5000) }).description.length, 2000);
});

test("the container is evidence for the others: its names, numbers and ids reach the search", async () => {
  const seen = [];
  const answer = await registry({ seen }).identify({ names: ["Release.Name.1080p"], kindHint: null,
    container: { title: "Сериал", seriesTitle: "Сериал", segmentTitle: "Release.Name.2021.1080p.WEB-DL", season: 2, episode: 5, episodeTitle: "Pilot",
      externalIds: { imdb: "tt0000001" } } });
  assert.equal(answer.status, "identified");
  // A release name the container states is a name too: it adds the year the file name lacks.
  assert.deepEqual(seen[0].names, ["Release.Name.1080p", "Сериал", "Release.Name.2021.1080p.WEB-DL"]);
  assert.deepEqual([seen[0].season, seen[0].episode, seen[0].episodeTitle], [2, 5, "Pilot"]);
  assert.deepEqual(seen[0].externalIds, { imdb: "tt0000001" });
  assert.equal(seen[0].kindHint, "tv", "a season the file states says the work is a series");
  assert.deepEqual(seen[0].episodeEvidence, { season: 2, titles: ["Pilot"] });
});

test("the release's own season of titles is kept over the one title a container states", async () => {
  const seen = [];
  const episodeEvidence = { season: 2, titles: ["One", "Two"] };
  await registry({ seen }).identify({ names: ["Show"], kindHint: "tv", episodeEvidence, container: { season: 2, episode: 1, episodeTitle: "Pilot" } });
  assert.deepEqual(seen[0].episodeEvidence, episodeEvidence);
});

test("an id the container states is looked up before any search, and replaces it", async () => {
  const searched = [];
  const looked = [];
  const tmdb = new TmdbProvider({
    identify: async (request) => { searched.push(request); return { status: "not-found" }; },
    identifyById: async (request) => { looked.push(request.externalIds); return { status: "identified", work }; },
    episodes: async () => ({ status: "ok" })
  });
  const answer = await new MetadataRegistry({ providers: [new ContainerMetadata(), tmdb] })
    .identify({ names: ["Anything"], container: { externalIds: { tmdb: { kind: "tv", id: 7 } } } });
  assert.equal(answer.status, "identified");
  assert.deepEqual(looked, [{ tmdb: { kind: "tv", id: 7 } }]);
  assert.equal(searched.length, 0);
});

test("an id that names nothing leaves the search by name to decide", async () => {
  const searched = [];
  const tmdb = new TmdbProvider({
    identify: async (request) => { searched.push(request); return { status: "identified", work }; },
    identifyById: async () => ({ status: "not-found" }),
    episodes: async () => ({ status: "ok" })
  });
  const answer = await new MetadataRegistry({ providers: [new ContainerMetadata(), tmdb] })
    .identify({ names: ["Example"], container: { externalIds: { imdb: "tt0000001" } } });
  assert.equal(answer.status, "identified");
  assert.equal(searched.length, 1);
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
/**
 * An AniList that answers from a table: a search by title or a record by id.
 *
 * @param {{ search?: Record<string, object[]>, byId?: Record<number, object> }} table
 */
function anilistFrom({ search = {}, byId = {} }) {
  const fetch = async (_url, init) => {
    const { variables } = JSON.parse(init.body);
    const data = variables.id !== undefined
      ? { Media: byId[variables.id] ?? null }
      : { Page: { pageInfo: { hasNextPage: false }, media: search[variables.search] ?? [] } };
    return new Response(JSON.stringify({ data }), { headers: { "content-type": "application/json" } });
  };
  return new AniListProvider({ fetch, gate: { run: task => task(), pause() {} } });
}

const drifters2016 = { id: 21662, title: { romaji: "Drifters", english: "Drifters", native: "ドリフターズ" }, synonyms: [], format: "TV", episodes: 12, startDate: { year: 2016 } };

test("the one anime AniList holds under a title moves TMDB's choice onto the candidate it agrees with", async () => {
  const tmdbWork = (tmdbId, year) => ({ ...work, tmdbId, title: "Drifters", originalTitle: "Drifters", year });
  const ranked = [
    { kind: "tv", tmdbId: 281558, title: "Drifters", year: 2019, score: 8, contradiction: null },
    { kind: "tv", tmdbId: 67075, title: "Drifters", year: 2016, score: 8, contradiction: null }
  ];
  const looked = [];
  const tmdb = new TmdbProvider({
    identify: async () => ({ status: "identified", work: tmdbWork(281558, 2019), ranked }),
    identifyById: async (request) => { looked.push(request.externalIds.tmdb); return { status: "identified", work: tmdbWork(request.externalIds.tmdb.id, 2016) }; },
    episodes: async () => ({ status: "ok" })
  });
  const answer = await new MetadataRegistry({ providers: [anilistFrom({ search: { Drifters: [drifters2016] } }), tmdb] })
    .identify({ names: ["[HorribleSubs] Drifters - 01 [1080p].mkv"], kindHint: "tv", language: "en-US" });
  assert.deepEqual(looked, [{ kind: "tv", id: 67075 }]);
  assert.equal(answer.work.sources.tmdb.tmdbId, 67075);
  assert.equal(answer.work.sources.tmdb.identification, "anilist");
});

test("a record the address names is looked up, not searched for", async () => {
  const searched = [];
  const looked = [];
  const tmdb = new TmdbProvider({
    identify: async (request) => {
      searched.push(request.names);
      return { status: "identified", work: { ...work, title: "Drifters", year: request.names.some((name) => name.includes("2016")) ? 2016 : 2019 } };
    },
    identifyById: async (request) => { looked.push(request.externalIds); return request.externalIds.tmdb ? { status: "identified", work } : { status: "not-found" }; },
    episodes: async () => ({ status: "ok" })
  });
  const byTmdb = await new MetadataRegistry({ providers: [new ContainerMetadata(), tmdb] })
    .identify({ names: ["Anything"], externalIds: { tmdb: { kind: "tv", id: 7 } } });
  assert.equal(byTmdb.work.sources.tmdb.tmdbId, 7);
  assert.equal(searched.length, 0);
  // An AniList id: the record, then the TMDB work of its title and year.
  const byAnilist = await new MetadataRegistry({ providers: [anilistFrom({ byId: { 21662: drifters2016 } }), tmdb] })
    .identify({ names: ["Drifters"], kindHint: "tv", externalIds: { anilist: 21662 } });
  assert.equal(byAnilist.work.sources.anilist.id, 21662);
  assert.equal(byAnilist.work.sources.tmdb.year, 2016);
  assert.ok(searched.some((names) => names.includes("Drifters 2016")));
});
