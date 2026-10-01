import test from "node:test";
import assert from "node:assert/strict";
import { matchesRussianTransliteration } from "../services/metadata/russian-transliteration.js";
import { MetadataService } from "../services/metadata/MetadataService.js";
import { MetadataCache } from "../services/metadata/MetadataCache.js";
import { SharedFetches } from "../services/metadata/SharedFetches.js";
import { subtitleEvidenceOf } from "../public/domain/subtitle-evidence.js";

const RU = "\u041f\u0440\u0438\u043d\u0446\u0435\u0441\u0441\u0430 \u041c\u043e\u043d\u043e\u043d\u043e\u043a\u044d";
test("Russian transliteration requires the complete title", () => {
  assert.equal(matchesRussianTransliteration("Princessa Mononoke", RU), true);
  assert.equal(matchesRussianTransliteration("Printsessa Mononoke", RU), true);
  assert.equal(matchesRussianTransliteration("Mononoke", RU), false);
  assert.equal(matchesRussianTransliteration("Princessa Mononoke 2", RU), false);
  assert.equal(matchesRussianTransliteration("Princessa Mononoke", "Princess Mononoke"), false);
});

function fixture({ count = 1, year = 1997, capped = false } = {}) {
  const calls = [];
  const source = {
    async search(kind, query, language, page) {
      calls.push([kind, query, language, page]);
      return { results: kind === "movie" && page === 1 ? Array.from({ length: count }, (_, i) => ({ id: 128 + i, name: "Princess Mononoke", year })) : [], totalPages: capped ? 4 : 1 };
    },
    async work(kind, id, language) { return { kind, tmdbId: id, title: language === "ru-RU" ? RU : "Princess Mononoke", year: 1997 }; },
    async alternativeTitles() { return [RU]; }
  };
  return { calls, service: new MetadataService({ source, cache: new MetadataCache({ budgetBytes: 1048576, maxEntryBytes: 65536 }), fetches: new SharedFetches({ waiterLimit: 64 }) }) };
}
const request = { names: ["Princessa.Mononoke.1997.BDRip.1080p.envy.mkv"], kindHint: "movie", language: "en-US" };
test("word discovery plus the Russian catalog title identifies Mononoke", async () => {
  const { service, calls } = fixture();
  const answer = await service.identifyTransliterated(request);
  assert.equal(answer.work.tmdbId, 128);
  assert.ok(calls.some(call => call[1] === "mononoke"));
});
test("wrong year, ambiguity and incomplete searches cannot identify", async () => {
  assert.equal((await fixture({ year: 2007 }).service.identifyTransliterated(request)).status, "not-found");
  assert.equal((await fixture({ count: 2 }).service.identifyTransliterated(request)).status, "ambiguous");
  assert.equal((await fixture({ capped: true }).service.identifyTransliterated(request)).status, "undetermined");
  assert.equal((await fixture({ count: 6 }).service.identifyTransliterated(request)).status, "undetermined");
});
test("explicit subtitle evidence must agree", async () => {
  assert.equal((await fixture().service.identifyTransliterated({ ...request, subtitleEvidence: { titles: [RU], years: [1997] } })).status, "identified");
  assert.equal((await fixture().service.identifyTransliterated({ ...request, subtitleEvidence: { titles: ["Another movie"], years: [1997] } })).status, "not-found");
  assert.equal((await fixture().service.identifyTransliterated({ ...request, subtitleEvidence: { titles: [], years: [2000] } })).status, "not-found");
});
test("a subtitle year can supply missing release evidence", async () => {
  const withoutYear = { ...request, names: ["Princessa.Mononoke.mkv"] };
  assert.equal((await fixture().service.identifyTransliterated(withoutYear)).status, "identified");
  assert.equal((await fixture().service.identifyTransliterated({ ...withoutYear, subtitleEvidence: { titles: [RU], years: [1997] } })).status, "identified");
});

test("a missing year still preserves ambiguity", async () => {
  const withoutYear = { ...request, names: ["Princessa.Mononoke.mkv"] };
  assert.equal((await fixture({ count: 2 }).service.identifyTransliterated(withoutYear)).status, "ambiguous");
});

test("Russian word discovery finds a series absent from Latin searches", async () => {
  const source = {
    search: async (_kind, query) => ({ totalPages: 1, results: query === "трудно" ? [{ id: 249720, name: "Hard to Be a God", originalName: "Трудно быть богом", year: 2026 }] : [] }),
    work: async (kind, id) => ({ kind, tmdbId: id, title: "Трудно быть богом", year: 2026 }),
    alternativeTitles: async () => []
  };
  const russian = new MetadataService({ source, cache: new MetadataCache({ budgetBytes: 1048576, maxEntryBytes: 65536 }), fetches: new SharedFetches({ waiterLimit: 64 }) });
  for (const name of ["Trudno.byt.bogom.S01.2026.WEB-DL.1080p.ExKinoRay", "Trudno.byt.bogom.S01"]) {
    assert.equal((await russian.identifyTransliterated({ names: [name], kindHint: "tv", language: "en-US" })).work.tmdbId, 249720);
  }
});
test("subtitle evidence excludes dialogue, invalid values and generic series titles", () => {
  const vtt = `WEBVTT\n\nNOTE TORRENT-TV-METADATA\n${JSON.stringify({ genericTitles: [RU], years: [1997, "2000"] })}\n\n00:00:00.000 --> 00:00:01.000\nAnother movie`;
  assert.deepEqual(subtitleEvidenceOf(vtt, "movie"), { titles: [RU], years: [1997] });
  assert.deepEqual(subtitleEvidenceOf(vtt, "tv"), { titles: [], years: [1997] });
  assert.equal(subtitleEvidenceOf("WEBVTT\n\nTitle: Another movie", "movie"), null);
});


test("the wrapper only expands a not-found answer", async () => {
  const { AnimeMetadata } = await import("../services/metadata/AnimeMetadata.js");
  for (const status of ["identified", "ambiguous", "unavailable", "undetermined"]) {
    let expanded = false;
    const wrapper = new AnimeMetadata({ identify: async () => ({ status, work: status === "identified" ? { kind: "movie", title: "Film", year: 1997 } : undefined }),
      identifyTransliterated: async () => { expanded = true; return { status: "not-found" }; } });
    await wrapper.identify(request);
    assert.equal(expanded, false, status);
  }
  let expanded = false;
  const wrapper = new AnimeMetadata({ identify: async () => ({ status: "not-found" }),
    identifyTransliterated: async () => { expanded = true; return { status: "not-found" }; } },
    { fetch: async () => Response.json({ data: { Page: { pageInfo: { hasNextPage: false }, media: [] } } }), gate: { run: callback => callback() } });
  await wrapper.identify(request);
  assert.equal(expanded, true);
});
