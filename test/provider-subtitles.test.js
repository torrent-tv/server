import assert from "node:assert/strict";
import test from "node:test";
import { SubtitleService, validateSubtitleQuery } from "../services/subtitles/SubtitleService.js";
import { OpenSubtitles } from "../services/subtitles/OpenSubtitles.js";
import { Jimaku } from "../services/subtitles/Jimaku.js";
import { SubtitleProvider } from "../services/subtitles/SubtitleProvider.js";
import { MetadataCache } from "../services/metadata/MetadataCache.js";
import { ProviderHttp, retryAt } from "../services/subtitles/ProviderHttp.js";
import { subtitleVtt } from "../services/subtitles/convert.js";
import { providerSubtitleQuery } from "../public/domain/provider-subtitles.js";
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

test("movie IDs and episode coordinates are validated independently", () => {
  assert.deepEqual(validateSubtitleQuery(query), query);
  assert.equal(validateSubtitleQuery({ kind: "series", tmdbId: 1 }), null);
  assert.equal(validateSubtitleQuery({ kind: "movie", tmdbId: "1" }), null);
  assert.equal(validateSubtitleQuery({ kind: "series", anilistId: 1, anilistEpisode: -1 }), null);
});

test("provider queries use matched TMDB episodes and never transfer their numbers to AniList", () => {
  const state = { work: { normalized: { kind: "series" }, sources: { tmdb: { tmdbId: 1 }, anilist: { id: 2 } } }, episodes: { 0: { season: 2, episodes: [{ number: 4 }], part: null } }, markers: { 0: { episodes: [16] } } };
  assert.deepEqual(providerSubtitleQuery(state, 0), { kind: "series", tmdbId: 1, anilistId: null, season: 2, episode: 4 });
  state.episodes[0].episodes.push({ number: 5 });
  assert.equal(providerSubtitleQuery(state, 0), null);
  delete state.work.sources.tmdb;
  assert.deepEqual(providerSubtitleQuery(state, 0), { kind: "series", tmdbId: null, anilistId: 2, anilistEpisode: 16 });
  state.markers[0].special = true;
  assert.equal(providerSubtitleQuery(state, 0), null);
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
  assert.equal(result.items.length, 1);
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
