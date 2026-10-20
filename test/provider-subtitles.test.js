import assert from "node:assert/strict";
import test from "node:test";
import { SubtitleService, validateSubtitleQuery } from "../services/subtitles/SubtitleService.js";
import { OpenSubtitles } from "../services/subtitles/OpenSubtitles.js";
import { Jimaku } from "../services/subtitles/Jimaku.js";
import { SubtitleProvider } from "../services/subtitles/SubtitleProvider.js";
import { MetadataCache } from "../services/metadata/MetadataCache.js";
import { ProviderHttp, retryAt } from "../services/subtitles/ProviderHttp.js";
import { subtitleVtt } from "../services/subtitles/convert.js";
import { filterSubtitleOffers, providerSubtitleLabel, providerSubtitleQuery } from "../public/domain/provider-subtitles.js";
import { RequestGate } from "../services/metadata/RequestGate.js";

const query = { kind: "movie", tmdbId: 4935, anilistId: null };
const item = { provider: "fake", id: "1", language: "en", filename: "film.srt" };
const cache = () => new MetadataCache({ budgetBytes: 1024 * 1024, maxEntryBytes: 128 * 1024 });
const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers });

test("discovery announces files without downloading and concurrent selections share one download", async () => {
  let searches = 0;
  let downloads = 0;
  const provider = { name: "fake", async search() { searches++; return { status: "complete", items: [item] }; }, async download() {
    downloads++; return { bytes: Buffer.from("1\n00:00:01,000 --> 00:00:02,000\nHello\n"), filename: "film.srt" };
  } };
  const service = new SubtitleService({ cache: cache(), providers: [provider] });
  const results = await Promise.all([service.search(query), service.search(query)]);
  assert.equal(searches, 1);
  assert.equal(downloads, 0);
  const token = results[0].providers[0].items[0].token;
  const files = await Promise.all([service.file(token), service.file(token)]);
  assert.equal(downloads, 1);
  assert.equal(files[0].vtt, files[1].vtt);
  assert.match(files[0].vtt, /Hello/u);
  await service.file(token);
  assert.equal(downloads, 1);
  assert.equal((await service.file(`${token}x`)).status, "expired");
});

test("failed discovery is not cached as an absent subtitle and one source cannot remove another", async () => {
  let failed = true;
  const service = new SubtitleService({ cache: cache(), providers: [
    { name: "bad", async search() { if (failed) throw new Error("refused"); return { status: "complete", items: [] }; } },
    { name: "fake", async search() { return { status: "complete", items: [item] }; } }
  ] });
  const first = await service.search(query);
  assert.equal(first.providers[0].status, "unavailable");
  assert.equal(first.providers[1].items.length, 1);
  failed = false;
  assert.equal((await service.search(query)).providers[0].status, "complete");
});

test("subtitle search cache keys include the file hash and fallback filename", async () => {
  const asked = [];
  const service = new SubtitleService({ cache: cache(), providers: [{ name: "fake", async search(query) {
    asked.push([query.fingerprint.hash, query.query]);
    return { status: "complete", items: [] };
  } }] });
  await service.search({ fingerprint: { hash: "0123456789abcdef", size: 200000 }, query: "first film" });
  await service.search({ fingerprint: { hash: "fedcba9876543210", size: 200000 }, query: "second film" });
  assert.deepEqual(asked, [["0123456789abcdef", "first film"], ["fedcba9876543210", "second film"]]);
});

test("movie IDs and episode coordinates are validated independently", () => {
  assert.deepEqual(validateSubtitleQuery(query), query);
  assert.deepEqual(validateSubtitleQuery({ fingerprint: { hash: "0123456789abcdef", size: 200000 } }), {
    tmdbId: null, anilistId: null, fingerprint: { hash: "0123456789abcdef", size: 200000 }
  });
  assert.equal(validateSubtitleQuery({ fingerprint: { hash: "0123456789ABCDEf", size: 200000 } }), null);
  assert.equal(validateSubtitleQuery({ fingerprint: { hash: "0123456789abcdef", size: 1 } }), null);
  assert.equal(validateSubtitleQuery({ tmdbId: 1 }), null);
  assert.equal(validateSubtitleQuery({ kind: "series", tmdbId: 1 }), null);
  assert.equal(validateSubtitleQuery({ kind: "movie", tmdbId: "1" }), null);
  assert.equal(validateSubtitleQuery({ kind: "series", anilistId: 1, anilistEpisode: -1 }), null);
});

test("provider queries use matched TMDB episodes and never transfer their numbers to AniList", () => {
  const fingerprint = { hash: "0123456789abcdef", size: 200000 };
  const state = { work: { normalized: { kind: "series" }, sources: { tmdb: { tmdbId: 1 }, anilist: { id: 2 } } }, episodes: { 0: { season: 2, episodes: [{ number: 4 }], part: null } }, markers: { 0: { episodes: [16] } }, fingerprints: { 0: fingerprint } };
  assert.deepEqual(providerSubtitleQuery(state, 0), { kind: "series", tmdbId: 1, anilistId: null, fingerprint, season: 2, episode: 4 });
  state.episodes[0].episodes.push({ number: 5 });
  assert.deepEqual(providerSubtitleQuery(state, 0), { fingerprint });
  delete state.work.sources.tmdb;
  assert.deepEqual(providerSubtitleQuery(state, 0), { kind: "series", tmdbId: null, anilistId: 2, fingerprint, anilistEpisode: 16 });
  state.markers[0].special = true;
  assert.deepEqual(providerSubtitleQuery(state, 0), { fingerprint });
});

test("a fingerprint alone searches providers before metadata has identified the work", () => {
  const fingerprint = { hash: "0123456789abcdef", size: 200000 };
  assert.deepEqual(providerSubtitleQuery({ fingerprints: { 2: fingerprint }, files: { 2: { relativePath: "Movies/Cowboy.Bebop.2021.mkv" } } }, 2), {
    fingerprint, query: "cowboy bebop 2021"
  });
  assert.equal(providerSubtitleQuery({ fingerprints: { 2: { hash: "bad", size: 200000 } } }, 2), null);
});

test("a hash match makes the provider's catalogue identity visible for checking", () => {
  const label = providerSubtitleLabel({ provider: "opensubtitles", language: "en", release: "release", hashMatch: true,
    identity: { title: "Cowboy Bebop", year: 2021 } });
  assert.match(label, /file hash match/u);
  assert.match(label, /catalogue: Cowboy Bebop \(2021\)/u);
  assert.match(providerSubtitleLabel({ provider: "opensubtitles", language: "en", eligibility: "unknown" }), /version unverified/u);
});

test("subtitle eligibility filters incompatible offers per language and keeps unknown fallback", () => {
  const offers = [
    { id: "en-good", language: "en", eligibility: "suitable" },
    { id: "en-same-label", language: "en", release: "same release label", eligibility: "suitable" },
    { id: "en-same-label-again", language: "en", release: "same release label", eligibility: "suitable" },
    { id: "en-unknown", language: "en", eligibility: "unknown" },
    { id: "en-wrong", language: "en", eligibility: "incompatible" },
    { id: "ru-unknown", language: "ru", eligibility: "unknown" },
    { id: "ru-wrong", language: "ru", eligibility: "incompatible" },
    { id: "fr-wrong", language: "fr", eligibility: "incompatible" }
  ];
  assert.deepEqual(filterSubtitleOffers(offers), {
    items: [offers[0], offers[1], offers[2], offers[3], offers[5]], excludedLanguages: ["fr"]
  });
});

test("OpenSubtitles and Jimaku extend the shared provider contract", () => {
  assert.ok(new OpenSubtitles({ key: "fake" }) instanceof SubtitleProvider);
  assert.ok(new Jimaku({ key: "fake" }) instanceof SubtitleProvider);
});

test("OpenSubtitles episode lookup sends the parent ID and does not offer a multi-CD part", async () => {
  let address;
  const provider = new OpenSubtitles({ key: "fake", fetch: async url => {
    address = url;
    return json({ total_pages: 1, data: [{ attributes: { language: "en", files: [{ file_id: 7, file_name: "a.srt" }] } }, { attributes: { language: "ru", files: [{ file_id: 8 }, { file_id: 9 }] } }] });
  } });
  const result = await provider.search({ kind: "series", tmdbId: 99, season: 2, episode: 3 });
  assert.equal(address.searchParams.get("parent_tmdb_id"), "99");
  assert.equal(address.searchParams.get("season_number"), "2");
  assert.equal(address.searchParams.get("episode_number"), "3");
  assert.equal(address.searchParams.has("page"), false);
  assert.equal(address.search, "?episode_number=3&parent_tmdb_id=99&season_number=2&type=episode");
  assert.equal(result.items.length, 1);
});

test("OpenSubtitles searches by file hash and exposes exact-match identity evidence", async () => {
  let address;
  const provider = new OpenSubtitles({ key: "fake", fetch: async url => {
    address = url;
    return json({ total_pages: 1, data: [{ attributes: {
      language: "en", moviehash_match: true, release: "Cowboy Bebop 2021",
      feature_details: { feature_type: "Episode", parent_tmdb_id: 84469, parent_imdb_id: 1267295, parent_title: "Cowboy Bebop", season_number: 1, episode_number: 1, year: 2021 },
      files: [{ file_id: 7, file_name: "episode.srt" }]
    } }] });
  } });
  const result = await provider.search({ fingerprint: { hash: "0123456789abcdef", size: 200000 }, query: "cowboy bebop 2021" });
  assert.equal(address.searchParams.get("moviehash"), "0123456789abcdef");
  assert.equal(address.searchParams.get("query"), "cowboy bebop 2021");
  assert.equal(address.searchParams.has("type"), false);
  assert.equal(result.items[0].hashMatch, true);
  assert.equal(result.items[0].eligibility, "suitable");
  assert.deepEqual(result.items[0].identity, {
    kind: "series", tmdbId: 84469, imdbId: "tt1267295", title: "Cowboy Bebop", season: 1, episode: 1
  });
});

test("an OpenSubtitles association without an exact hash match is not identity evidence", async () => {
  const provider = new OpenSubtitles({ key: "fake", fetch: async () => json({ total_pages: 1, data: [{ attributes: {
    language: "en", moviehash_match: false, feature_details: { feature_type: "Movie", tmdb_id: 377 }, files: [{ file_id: 7 }]
  } }] }) });
  const result = await provider.search({ fingerprint: { hash: "0123456789abcdef", size: 200000 } });
  assert.equal(result.items[0].hashMatch, undefined);
  assert.equal(result.items[0].eligibility, "unknown");
  assert.equal(result.items[0].identity, undefined);
});

test("429 pauses shared provider requests and Retry-After dates are respected", async () => {
  let calls = 0;
  const http = new ProviderHttp({ origin: "https://example.com", headers: {}, fetch: async () => { calls++; return json({}, 429, { "retry-after": "30" }); } });
  await assert.rejects(http.json("/search"));
  await assert.rejects(http.json("/download", {}));
  assert.equal(calls, 1);
  assert.ok(http.gate.pausedUntil > Date.now());
  assert.equal(retryAt(new Headers({ "retry-after": "Thu, 01 Jan 1970 00:02:00 GMT" }), 0), 120000);
  assert.equal(retryAt(new Headers({ "x-ratelimit-reset-after": "2.5" }), 1000), 3500);
});

test("selected downloads precede waiting searches without interrupting an active request", async () => {
  const gate = new RequestGate({ concurrency: 1, perSecond: Infinity, queueLimit: 4 });
  const order = [];
  let finish;
  const first = gate.run(() => new Promise(resolve => { finish = resolve; }), { deadlineAt: Date.now() + 1000 });
  await Promise.resolve();
  const search = gate.run(async () => { order.push("search"); }, { deadlineAt: Date.now() + 1000 });
  const download = gate.run(async () => { order.push("download"); }, { deadlineAt: Date.now() + 1000, priority: 1 });
  finish();
  await Promise.all([first, search, download]);
  assert.deepEqual(order, ["download", "search"]);
});

test("download redirects cannot send a request or API credentials to an unrelated host", async () => {
  const requests = [];
  const http = new ProviderHttp({ origin: "https://jimaku.cc", headers: { Authorization: "private" }, fetch: async (url, options) => {
    requests.push({ url, options }); return new Response(null, { status: 302, headers: { location: "http://127.0.0.1/private" } });
  } });
  await assert.rejects(http.file("https://jimaku.cc/file.srt", ["jimaku.cc"]));
  assert.equal(requests.length, 1);
  assert.equal(requests[0].options.headers.Authorization, undefined);
});

test("SRT and declared ASS columns preserve timestamps, line breaks and literal text", () => {
  const srt = subtitleVtt(Buffer.from("1\n00:00:01,250 --> 00:00:02,500\n<hello> & bye\n"), "a.srt");
  assert.match(srt, /00:00:01\.250 --> 00:00:02\.500/u);
  assert.match(srt, /&lt;hello&gt; &amp; bye/u);
  const ass = subtitleVtt(Buffer.from("[Events]\nFormat: End, Start, Text\nDialogue: 0:00:02.50,0:00:01.25,{\\i1}Hello\\NWorld, yes\n"), "a.ass");
  assert.match(ass, /00:00:01\.250 --> 00:00:02\.500/u);
  assert.match(ass, /Hello\nWorld, yes/u);
  assert.throws(() => subtitleVtt(Buffer.from("not a subtitle"), "a.srt"));
});


test("confirmed movie IMDb identities reach OpenSubtitles without reusing empty TMDB results", async () => {
  const addresses = [];
  const provider = new OpenSubtitles({ key: "fake", fetch: async url => {
    addresses.push(url.search);
    return json({ total_pages: 1, data: url.searchParams.has("imdb_id") ? [{ attributes: {
      language: "en", feature_details: { imdb_id: 1312221, tmdb_id: null }, files: [{ file_id: 7, file_name: "film.srt" }]
    } }] : [] });
  } });
  const state = { work: { normalized: { kind: "movie" }, sources: { tmdb: { tmdbId: 1062722, imdbId: "tt1312221" } } } };
  const confirmed = providerSubtitleQuery(state, 0);
  assert.equal(confirmed.imdbId, "tt1312221");
  assert.deepEqual(validateSubtitleQuery(confirmed), confirmed);
  assert.equal(validateSubtitleQuery({ ...confirmed, imdbId: "https://example.com" }), null);
  const service = new SubtitleService({ cache: cache(), providers: [provider] });
  assert.equal((await service.search({ ...query, tmdbId: 1062722 })).providers[0].items.length, 0);
  assert.equal((await service.search(confirmed)).providers[0].items.length, 1);
  assert.equal((await service.search(confirmed)).providers[0].items.length, 1);
  assert.deepEqual(addresses, ["?tmdb_id=1062722&type=movie", "?imdb_id=1312221&type=movie"]);
});


test("OpenSubtitles receives numeric IMDb IDs without redirect-producing leading zeros", async () => {
  let address;
  const provider = new OpenSubtitles({ key: "fake", fetch: async url => {
    address = url;
    return json({ total_pages: 1, data: [] });
  } });
  await provider.search({ kind: "movie", tmdbId: 1368, imdbId: "tt0083944" });
  assert.equal(address.search, "?imdb_id=83944&type=movie");
});
