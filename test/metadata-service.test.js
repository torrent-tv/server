/**
 * @file The metadata service against a fake provider, and the parts that bound
 * its load: the gate, the cache, shared fetches, bounded reading, the TMDB
 * client's handling of `429`, and the image fetcher.
 *
 * No request leaves this machine: every provider here is a function.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { MetadataService } from "../services/metadata/MetadataService.js";
import { MetadataCache } from "../services/metadata/MetadataCache.js";
import { SharedFetches } from "../services/metadata/SharedFetches.js";
import { MetadataUnavailableError, RequestGate } from "../services/metadata/RequestGate.js";
import { readBoundedBody } from "../services/metadata/bounded-body.js";
import { TmdbSource } from "../services/metadata/TmdbSource.js";
import { ImageFetcher } from "../services/metadata/ImageFetcher.js";

/**
 * A provider that answers searches from a table and counts what it is asked.
 *
 * @param {Record<string, Array<{ id: number, name: string, year: number | null }>>} table - `kind|query` → results.
 * @param {{ fail?: Set<string>, totalPages?: number, seasons?: Record<string, string[]>, alternative?: Record<string, string[]> }} [options]
 */
function fakeSource(table, { fail = new Set(), totalPages = 1, seasons = {}, alternative = {} } = {}) {
  const asked = [];
  return {
    asked,
    async search(kind, query, _language, page) {
      asked.push(`search|${kind}|${query}|${page}`);
      if (fail.has(`${kind}|${query}`)) {
        throw new MetadataUnavailableError("the provider answered 500");
      }
      const results = (table[`${kind}|${query}`] ?? []).map((one) => ({ ...one, originalName: one.name }));
      return { results: page === 1 ? results : [], totalPages };
    },
    async work(kind, id) {
      asked.push(`work|${kind}|${id}`);
      return { kind, tmdbId: id, title: "T", originalTitle: "T", year: 2000, overview: "", poster: null, backdrop: null, seasons: [] };
    },
    async alternativeTitles(kind, id) {
      asked.push(`alternative|${kind}|${id}`);
      return alternative[`${kind}|${id}`] ?? [];
    },
    async season(id, number) {
      asked.push(`season|${id}|${number}`);
      const names = seasons[`${id}|${number}`] ?? ["One"];
      return { number, name: `Season ${number}`, episodes: names.map((name, index) => ({ number: index + 1, name, still: null })) };
    }
  };
}

/**
 * @param {ReturnType<typeof fakeSource> | null} source
 */
function service(source) {
  return new MetadataService({
    source,
    cache: new MetadataCache({ budgetBytes: 1 << 20, maxEntryBytes: 1 << 16 }),
    fetches: new SharedFetches({ waiterLimit: 64 })
  });
}

test("without a token nothing is asked and the answer is unavailable", async () => {
  assert.deepEqual(await service(null).identify({ names: ["Title"], kindHint: null, language: "en-US" }), { status: "unavailable" });
});

test("a series is looked for as a series, with and without the season number LostFilm puts after the title", async () => {
  const source = fakeSource({ "tv|Firefly": [{ id: 1437, name: "Firefly", year: 2002 }] });
  const answer = await service(source).identify({ names: ["Firefly 1 - LostFilm.TV [1080p]"], kindHint: "tv", language: "en-US" });
  assert.equal(answer.status, "identified");
  assert.equal(answer.work.tmdbId, 1437);
  assert.ok(source.asked.includes("search|tv|Firefly 1|1"));
  assert.ok(!source.asked.some((line) => line.startsWith("search|movie")));
});

test("an apostrophe is sent as written, not normalized away", async () => {
  const source = fakeSource({ "tv|Agatha Christie's Poirot": [{ id: 790, name: "Agatha Christie's Poirot", year: 1989 }] });
  const answer = await service(source).identify({
    names: ["Пуаро_Агаты_Кристи_Agatha_Christie`s_Poirot_Сезон_1_13_из_13_Серии.torrent", "Poirot.1989-2013.hdrip_[teko]"],
    kindHint: "tv",
    language: "en-US"
  });
  assert.equal(answer.status, "identified");
  assert.equal(answer.work.tmdbId, 790);
});

test("a refused search is not remembered as nothing found", async () => {
  const fail = new Set(["movie|Title"]);
  const source = fakeSource({ "movie|Title": [{ id: 1, name: "Title", year: 2020 }] }, { fail });
  const metadata = service(source);
  assert.equal((await metadata.identify({ names: ["Title.2020.1080p"], kindHint: "movie", language: "en-US" })).status, "unavailable");
  fail.clear();
  assert.equal((await metadata.identify({ names: ["Title.2020.1080p"], kindHint: "movie", language: "en-US" })).status, "identified");
});

test("a search is cached per language, and a repeated question asks nothing", async () => {
  const source = fakeSource({ "movie|Title": [{ id: 1, name: "Title", year: 2020 }] });
  const metadata = service(source);
  await metadata.identify({ names: ["Title.2020"], kindHint: "movie", language: "en-US" });
  const afterFirst = source.asked.length;
  await metadata.identify({ names: ["Title.2020"], kindHint: "movie", language: "en-US" });
  assert.equal(source.asked.length, afterFirst);
  await metadata.identify({ names: ["Title.2020"], kindHint: "movie", language: "de-DE" });
  assert.ok(source.asked.length > afterFirst);
});

test("a transliterated title is identified by the provider's alternative titles", async () => {
  const source = fakeSource(
    { "movie|Trudno byt Bogom": [{ id: 110402, name: "Hard to Be a God", year: 2014 }] },
    { alternative: { "movie|110402": ["It's hard to be a God", "Trudno byt' bogom"] } }
  );
  const answer = await service(source).identify({ names: ["Trudno.byt.Bogom.2013.RUS.BDRip.XviD.AC3.-HQCLU"], kindHint: null, language: "en-US" });
  assert.equal(answer.status, "identified");
  assert.equal(answer.work.tmdbId, 110402);
});

test("without a stated year the alternative titles are not consulted", async () => {
  const source = fakeSource(
    { "movie|Trudno byt Bogom": [{ id: 110402, name: "Hard to Be a God", year: 2014 }] },
    { alternative: { "movie|110402": ["Trudno byt' bogom"] } }
  );
  const answer = await service(source).identify({ names: ["Trudno.byt.Bogom"], kindHint: "movie", language: "en-US" });
  assert.equal(answer.status, "not-found");
  assert.ok(!source.asked.some((line) => line.startsWith("alternative|")));
});

test("a shortened series title is identified by the episode names of its files", async () => {
  const source = fakeSource(
    { "tv|Poirot": [{ id: 790, name: "Agatha Christie's Poirot", year: 1989 }, { id: 9, name: "Loriot", year: 1976 }] },
    { seasons: { "790|1": ["The Adventure of the Clapham Cook", "Murder in the Mews", "The Dream"] } }
  );
  const answer = await service(source).identify({
    names: ["Poirot.1989-2013.hdrip_[teko]"],
    kindHint: "tv",
    episodeEvidence: { season: 1, titles: ["The.Adventure.of.the.Clapham.Cook", "Murder.in.the.Mews"] },
    language: "en-US"
  });
  assert.equal(answer.status, "identified");
  assert.equal(answer.work.tmdbId, 790);
  // Only the result the stated year admits was checked.
  assert.ok(!source.asked.includes("season|9|1"));
});

test("without a stated year the episode names are not consulted", async () => {
  const source = fakeSource({ "tv|Poirot": [{ id: 790, name: "Agatha Christie's Poirot", year: 1989 }] });
  const answer = await service(source).identify({
    names: ["Poirot"],
    kindHint: "tv",
    episodeEvidence: { season: 1, titles: ["A", "B"] },
    language: "en-US"
  });
  assert.equal(answer.status, "not-found");
  assert.ok(!source.asked.some((line) => line.startsWith("season|")));
});

test("a picture that must state a year and does not is not searched for", async () => {
  const source = fakeSource({ "movie|27 nights": [{ id: 1, name: "27 Nights", year: 2025 }] });
  const answer = await service(source).identify({ names: ["27_nights"], kindHint: null, requireYear: true, language: "en-US" });
  assert.equal(answer.status, "undetermined");
  assert.deepEqual(source.asked, []);
});

test("more pages than are read make a single match undetermined", async () => {
  const source = fakeSource({ "movie|Title": [{ id: 1, name: "Title", year: 2020 }] }, { totalPages: 9 });
  const answer = await service(source).identify({ names: ["Title"], kindHint: "movie", language: "en-US" });
  assert.equal(answer.status, "undetermined");
  assert.equal(source.asked.filter((line) => line.startsWith("search|movie|Title|")).length, 3);
});

test("episodes of one season are fetched once and matched", async () => {
  const source = fakeSource({});
  const metadata = service(source);
  const request = { tmdbId: 7, season: 1, language: "en-US", files: [{ key: "0", episodes: [1], titleHint: "" }] };
  const answer = await metadata.episodes(request);
  await metadata.episodes(request);
  assert.equal(answer.status, "matched-season");
  assert.equal(answer.files[0].status, "matched");
  assert.equal(source.asked.filter((line) => line === "season|7|1").length, 1);
});

test("the cache drops the oldest entries past its budget and refuses an oversized one", () => {
  const cache = new MetadataCache({ budgetBytes: 200, maxEntryBytes: 120 });
  // 80 characters are 82 bytes of JSON plus a one-byte key: two fit, three do not.
  cache.set("a", "x".repeat(80), 1000);
  cache.set("b", "y".repeat(80), 1000);
  cache.set("c", "z".repeat(80), 1000);
  assert.equal(cache.get("a"), undefined);
  assert.equal(cache.get("c"), "z".repeat(80));
  assert.ok(cache.stats().bytes <= 200);
  assert.equal(cache.set("big", "w".repeat(200), 1000), false);
});

test("the cache forgets an entry at its expiry", () => {
  let now = 0;
  const cache = new MetadataCache({ budgetBytes: 1000, maxEntryBytes: 1000, now: () => now });
  cache.set("a", 1, 100);
  now = 99;
  assert.equal(cache.get("a"), 1);
  now = 100;
  assert.equal(cache.get("a"), undefined);
});

test("a browser leaving detaches its wait and not the shared fetch", async () => {
  const fetches = new SharedFetches({ waiterLimit: 8 });
  let release;
  let starts = 0;
  const start = () => {
    starts += 1;
    return new Promise((resolve) => {
      release = resolve;
    });
  };
  const leaving = new AbortController();
  const first = fetches.join("k", start, { deadlineAt: Date.now() + 5000, signal: leaving.signal });
  const second = fetches.join("k", start, { deadlineAt: Date.now() + 5000 });
  leaving.abort();
  await assert.rejects(first, MetadataUnavailableError);
  release("answer");
  assert.equal(await second, "answer");
  assert.equal(starts, 1);
});

test("waiters are bounded on their own", async () => {
  const fetches = new SharedFetches({ waiterLimit: 1 });
  const pending = fetches.join("k", () => new Promise(() => {}), { deadlineAt: Date.now() + 50 });
  await assert.rejects(fetches.join("k", () => Promise.resolve(1), { deadlineAt: Date.now() + 50 }), MetadataUnavailableError);
  await assert.rejects(pending, MetadataUnavailableError);
});

test("the gate refuses past its queue and while paused", async () => {
  const gate = new RequestGate({ concurrency: 1, perSecond: Infinity, queueLimit: 1 });
  const never = () => new Promise(() => {});
  const running = gate.run(never, { deadlineAt: Date.now() + 1000 });
  const queued = gate.run(never, { deadlineAt: Date.now() + 1000 });
  await assert.rejects(gate.run(never, { deadlineAt: Date.now() + 1000 }), MetadataUnavailableError);
  gate.pause(Date.now() + 1000);
  await assert.rejects(queued, MetadataUnavailableError);
  await assert.rejects(gate.run(() => Promise.resolve(1), { deadlineAt: Date.now() + 1000 }), MetadataUnavailableError);
  void running;
});

test("a body larger than its limit is abandoned", async () => {
  await assert.rejects(readBoundedBody(new Response("x".repeat(100)), 10), MetadataUnavailableError);
  assert.equal((await readBoundedBody(new Response("abc"), 10)).toString(), "abc");
});

test("a 429 pauses the source and the request is tried once more inside its deadline", async () => {
  let calls = 0;
  const fetch = async () => {
    calls += 1;
    return calls === 1
      ? new Response("", { status: 429, headers: { "retry-after": "0" } })
      : Response.json({ results: [{ id: 1, name: "T", original_name: "T", first_air_date: "2001-01-01" }], total_pages: 1 });
  };
  const source = new TmdbSource({ token: "test", gate: new RequestGate({ concurrency: 2, perSecond: Infinity, queueLimit: 8 }), fetch });
  const found = await source.search("tv", "T", "en-US", 1, { deadlineAt: Date.now() + 2000 });
  assert.equal(found.results[0].year, 2001);
  assert.equal(calls, 2);
});

test("a 429 whose pause outlasts the deadline is unavailable, not retried", async () => {
  let calls = 0;
  const fetch = async () => {
    calls += 1;
    return new Response("", { status: 429, headers: { "retry-after": "60" } });
  };
  const source = new TmdbSource({ token: "test", gate: new RequestGate({ concurrency: 2, perSecond: Infinity, queueLimit: 8 }), fetch });
  await assert.rejects(source.search("tv", "T", "en-US", 1, { deadlineAt: Date.now() + 1000 }), MetadataUnavailableError);
  assert.equal(calls, 1);
});

test("the image fetcher serves only TMDB images and passes their caching headers on", async () => {
  const asked = [];
  const fetch = async (url) => {
    asked.push(url);
    return new Response(new Uint8Array([1, 2, 3]), {
      headers: { "content-type": "image/jpeg", "cache-control": "public, max-age=31919000" }
    });
  };
  const images = new ImageFetcher({ gate: new RequestGate({ concurrency: 1, perSecond: Infinity, queueLimit: 4 }), fetch });
  const answer = await images.fetch("w342", "abcdefgh.jpg");
  assert.equal(answer.headers["cache-control"], "public, max-age=31919000");
  assert.deepEqual(asked, ["https://image.tmdb.org/t/p/w342/abcdefgh.jpg"]);
  await assert.rejects(images.fetch("original", "abcdefgh.jpg"), MetadataUnavailableError);
  await assert.rejects(images.fetch("w342", "../etc/passwd"), MetadataUnavailableError);
});

test("an image source that answers something other than an image is refused", async () => {
  const fetch = async () => new Response("<html>", { headers: { "content-type": "text/html" } });
  const images = new ImageFetcher({ gate: new RequestGate({ concurrency: 1, perSecond: Infinity, queueLimit: 4 }), fetch });
  await assert.rejects(images.fetch("w342", "abcdefgh.jpg"), MetadataUnavailableError);
});
