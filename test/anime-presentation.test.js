import test from "node:test";
import assert from "node:assert/strict";
import { AnimeMetadata, hasAnimeHints } from "../services/metadata/AnimeMetadata.js";
import { normalizeWork } from "../services/metadata/normalize-work.js";
import { pageTitle, playlistNaming, playerArt, systemArtwork } from "../public/domain/media-info.js";
import { playlistRows } from "../public/domain/playlist-groups.js";

const anime = { id: 1, title: { english: "Example", romaji: "Example", native: "例" }, synonyms: [], format: "TV", startDate: { year: 2026 } };
const tmdb = { tmdbId: 2, kind: "tv", title: "Example", originalTitle: "例", year: 2026, seasons: [{number: 1}], images: [] };
function service(answer, results = [anime], { incomplete = false, fail = false } = {}) {
  let calls = 0;
  const fetch = async () => {
    calls++;
    if (fail) throw new Error("offline");
    return new Response(JSON.stringify({ data: { Page: { media: results, pageInfo: { hasNextPage: incomplete } } } }));
  };
  const gate = { run: task => task(), pause() {} };
  return { metadata: new AnimeMetadata({ identify: async () => answer, episodes: request => request }, { fetch, gate }), calls: () => calls };
}

test("normalization preserves providers separately and records provenance", () => {
  const work = normalizeWork(tmdb, anime);
  assert.equal(work.sources.tmdb, tmdb);
  assert.equal(work.sources.anilist, anime);
  assert.equal(work.normalized.kind, "series");
  assert.equal(work.normalized.title, "Example");
  assert.equal(work.normalized.provenance.isAnime, "anilist");
});

test("anime hints always consult AniList even after TMDB identifies the work", async () => {
  const { metadata, calls } = service({ status: "identified", work: tmdb });
  const result = await metadata.identify({ names: ["[HorribleSubs] Example 2026"], kindHint: "tv", language: "en-US" });
  assert.equal(calls(), 1);
  assert.equal(result.work.sources.anilist.id, 1);
});

test("a TMDB anime keyword consults AniList without filename hints", async () => {
  const { metadata, calls } = service({ status: "identified", work: { ...tmdb, anime: true } });
  await metadata.identify({ names: ["Example 2026"], kindHint: "tv", language: "en-US" });
  assert.ok(calls() > 0);
});

test("ordinary TMDB matches do not consult AniList", async () => {
  const { metadata, calls } = service({ status: "identified", work: tmdb });
  const result = await metadata.identify({ names: ["Example 2026"], kindHint: "tv" });
  assert.equal(calls(), 0);
  assert.ok(result.work.normalized);
});

test("not-found consults AniList and can identify an anime without inventing seasons", async () => {
  const { metadata, calls } = service({ status: "not-found" });
  const result = await metadata.identify({ names: ["Example 2026"], kindHint: "tv" });
  assert.equal(calls(), 1);
  assert.equal(result.work.sources.anilist.id, 1);
  assert.deepEqual(result.work.normalized.seasons, []);
  assert.equal(result.work.sources.tmdb, undefined);
});

test("a year-bearing AniList synonym identifies the supplied 2026 series", async () => {
  const entry = {...anime, title:{english:"THE GHOST IN THE SHELL",romaji:"Koukaku Kidoutai: THE GHOST IN THE SHELL"},synonyms:["Koukaku Kidoutai (2026)"]};
  const {metadata}=service({status:"not-found"},[entry]);
  const result=await metadata.identify({names:["Koukaku Kidoutai (2026) S1"],kindHint:"tv"});
  assert.equal(result.work.sources.anilist.id,1);
});

test("ambiguous and incomplete anime results are never selected", async () => {
  for (const [results, options] of [[[anime, {...anime,id:3}], {}], [[anime], {incomplete:true}]]) {
    const { metadata } = service({status:"not-found"}, results, options);
    const result = await metadata.identify({names:["Example 2026"],kindHint:"tv"});
    assert.equal(result.status, "not-found");
  }
});

test("a differing or missing anime year does not prevent identification", async () => {
  for (const year of [2000, null]) {
    const { metadata } = service({ status: "not-found" }, [{ ...anime, startDate: { year } }]);
    const result = await metadata.identify({ names: ["Example 2026"], kindHint: "tv" });
    assert.equal(result.status, "identified");
    assert.equal(result.work.sources.anilist.id, 1);
  }
});

test("AniList failure retains the confirmed TMDB record", async () => {
  const { metadata } = service({status:"identified",work:tmdb}, [], {fail:true});
  const result = await metadata.identify({names:["Anime Example 2026"],kindHint:"tv"});
  assert.equal(result.work.sources.tmdb.tmdbId, 2);
});

test("release numbering remains separate from provider numbering in page titles", () => {
  const state = {work:normalizeWork(tmdb), markers:{0:{season:2,episodes:[12]}}, episodes:{0:{season:2,episodes:[{number:11,name:"Title"}]}}};
  assert.equal(pageTitle(state,0), "Torrent TV | Example | Season 2 | Episode 12: Title");
  assert.equal(pageTitle({...state,episodes:{}},0), "Torrent TV | Example | Season 2 | Episode 12");
  assert.equal(playlistNaming(state).fileLabel({index:0},{grouped:true}),"12. Title");
  assert.equal(playlistNaming({...state,episodes:{0:{season:2,episodes:[{number:11,name:"Episode 11"}]}}}).fileLabel({index:0},{grouped:true}),"Episode 12");
  assert.equal(pageTitle(null,0), "Torrent TV");
});

test("a single known season has a group even when all files are at the root", () => {
  const state={work:normalizeWork(tmdb),markers:{0:{season:1,episodes:[1]},1:{season:1,episodes:[2]}},episodes:{}};
  const rows=playlistRows([{index:0,relativePath:"a.mkv"},{index:1,relativePath:"b.mkv"}],playlistNaming(state));
  assert.equal(rows.length,1);
  assert.equal(rows[0].label,"Season 1");
  assert.deepEqual(rows[0].files.map(f=>f.label),["Episode 1","Episode 2"]);
});

test("artwork is chosen at random among images of the orientation and size needed", () => {
  const state={work:normalizeWork({...tmdb,images:[
    {kind:"backdrop",file:"backdropsmall.jpg",width:640,height:360},
    {kind:"backdrop",file:"backdropfirst.jpg",width:1920,height:1080},
    {kind:"poster",file:"poster1234.jpg",width:2000,height:3000},
    {kind:"backdrop",file:"backdropsecond.jpg",width:3840,height:2160},
    {kind:"backdrop",file:"backdropthird.jpg",width:1280,height:720}
  ]})};
  const chosen=random=>playerArt(state,0,800,450,1,random).url.split("/").pop();
  // Only the three backdrops large enough for 800x450 take part, each with an
  // equal share of the range, in the order the server sent them.
  assert.equal(chosen(() => 0),"backdropfirst.jpg");
  assert.equal(chosen(() => 0.34),"backdropsecond.jpg");
  assert.equal(chosen(() => 0.99),"backdropthird.jpg");
});

test("the system media controls get a random poster at least as wide as their slot", () => {
  const state={work:normalizeWork({...tmdb,poster:"mainposter.jpg",images:[
    {kind:"poster",file:"postertiny.jpg",width:150,height:225},
    {kind:"backdrop",file:"backdropwide.jpg",width:1920,height:1080},
    {kind:"poster",file:"posterfirst.jpg",width:1000,height:1500},
    {kind:"poster",file:"postersecond.jpg",width:680,height:1000}
  ]})};
  assert.deepEqual(systemArtwork(state,0,() => 0),{url:"/api/metadata/image/w185/posterfirst.jpg",sizes:"185x278"});
  assert.deepEqual(systemArtwork(state,0,() => 0.99),{url:"/api/metadata/image/w185/postersecond.jpg",sizes:"185x272"});
  // A work with no listed posters keeps its main one.
  const plain={work:normalizeWork({...tmdb,poster:"mainposter.jpg"})};
  assert.deepEqual(systemArtwork(plain,0,() => 0),{url:"/api/metadata/image/w185/mainposter.jpg",sizes:"185x278"});
  assert.equal(systemArtwork(null,0),null);
});

test("without a large enough image the largest of the orientation is kept", () => {
  const state={work:normalizeWork({...tmdb,images:[
    {kind:"backdrop",file:"backdropsmall.jpg",width:640,height:360},
    {kind:"backdrop",file:"backdroplarger.jpg",width:1280,height:720}
  ]})};
  assert.equal(playerArt(state,0,1920,1080,1,() => 0).url,"/api/metadata/image/original/backdroplarger.jpg");
});

test("artwork chooses orientation and the smallest sufficient size for density", () => {
  const state={work:normalizeWork({...tmdb,images:[{kind:"poster",file:"poster1234.jpg",width:1000,height:1500},{kind:"backdrop",file:"backdrop12.jpg",width:1920,height:1080}]})};
  assert.equal(playerArt(state,0,400,700,1).url,"/api/metadata/image/w500/poster1234.jpg");
  assert.equal(playerArt(state,0,800,450,1).url,"/api/metadata/image/w1280/backdrop12.jpg");
  assert.equal(playerArt(state,0,800,450,2).url,"/api/metadata/image/original/backdrop12.jpg");
  assert.equal(playerArt(state,0,400,700,1,() => 0.99).url,"/api/metadata/image/w500/poster1234.jpg");
  assert.ok(hasAnimeHints(["Example OVA"]));
  assert.equal(hasAnimeHints(["Example S02E12"]),false);
});
