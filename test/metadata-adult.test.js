import test from "node:test";
import assert from "node:assert/strict";
import { MetadataRegistry } from "../services/metadata/MetadataRegistry.js";
import { TmdbProvider } from "../services/metadata/TmdbProvider.js";
import { ThePornDbProvider } from "../services/metadata/ThePornDbProvider.js";
import { StashDbProvider } from "../services/metadata/StashDbProvider.js";

const gate = { run: task => task(), pause() {} };
const hash = "8e245d9679d31e12";

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** A fetch that answers from a list and records what it was asked. */
function fakeFetch(answers, seen = []) {
  return async (url, init) => { seen.push({ url: String(url), init }); return json(answers.shift()); };
}

const tpdbScene = { id: "abc", title: "Geography Test", date: "2007-03-30", description: "text", site: { name: "Oldje" }, performers: [{ name: "A" }, { name: "B" }] };
const stashScene = { id: "s1", title: "Brazzers Beach", details: null, release_date: "2025-07-15", studio: { name: "Brazzers Exxtra" }, performers: [{ performer: { name: "Angela" } }] };

test("an adult source is asked only for the category adult, and the general ones are not asked then", () => {
  const tpdb = new ThePornDbProvider({ key: "k", fetch: fakeFetch([]), gate });
  const tmdb = new TmdbProvider({});
  assert.equal(tpdb.accepts({ names: ["x"] }), false);
  assert.equal(tpdb.accepts({ names: ["x"], category: "adult" }), true);
  assert.equal(tmdb.accepts({ names: ["x"] }), true);
  assert.equal(tmdb.accepts({ names: ["x"], category: "adult" }), false);
});

test("ThePornDB identifies by the file hash first and reduces the scene to the common fields", async () => {
  const seen = [];
  const provider = new ThePornDbProvider({ key: "secret-key", fetch: fakeFetch([{ data: [tpdbScene] }], seen), gate });
  const answer = await provider.identify({ names: ["whatever"], fingerprint: { hash, size: 1 } });
  assert.equal(answer.status, "identified");
  assert.match(seen[0].url, /hash=8e245d9679d31e12&hashType=OSHASH/);
  assert.equal(seen[0].init.headers.Authorization, "Bearer secret-key");
  assert.deepEqual(provider.fields(answer.records.theporndb), { kind: "movie", title: "Geography Test", year: 2007, overview: "text", studio: "Oldje", performers: ["A", "B"], adult: true });
});

test("ThePornDB does not show a name that fits several scenes or none", async () => {
  const many = new ThePornDbProvider({ key: "k", fetch: fakeFetch([{ data: [tpdbScene, { ...tpdbScene, id: "other" }] }]), gate });
  assert.equal((await many.identify({ names: ["a"] })).status, "ambiguous");
  const none = new ThePornDbProvider({ key: "k", fetch: fakeFetch([{ data: [] }]), gate });
  assert.equal((await none.identify({ names: ["a"] })).status, "not-found");
});

test("a refusal by the database is unavailable, never a work", async () => {
  const provider = new ThePornDbProvider({ key: "k", fetch: async () => json({ message: "no" }, 401), gate });
  assert.equal((await provider.identify({ names: ["a"] })).status, "unavailable");
});

test("StashDB identifies by fingerprint through GraphQL", async () => {
  const seen = [];
  const provider = new StashDbProvider({ key: "stash-key", fetch: fakeFetch([{ data: { findScenesBySceneFingerprints: [[stashScene]] } }], seen), gate });
  const answer = await provider.identify({ names: ["x"], fingerprint: { hash, size: 1 } });
  assert.equal(answer.status, "identified");
  assert.equal(seen[0].init.headers.ApiKey, "stash-key");
  assert.deepEqual(JSON.parse(seen[0].init.body).variables.f, [[{ hash, algorithm: "OSHASH" }]]);
  assert.deepEqual(provider.fields(answer.records.stashdb).performers, ["Angela"]);
});

test("StashDB takes a name only when exactly one title is in it and the years agree", async () => {
  const search = scenes => new StashDbProvider({ key: "k", fetch: fakeFetch([{ data: { searchScene: scenes } }]), gate });
  assert.equal((await search([stashScene]).identify({ names: ["Brazzers.Beach.2025.1080p.mp4"] })).status, "identified");
  assert.equal((await search([stashScene]).identify({ names: ["Brazzers.Beach.2019.1080p.mp4"] })).status, "not-found");
  assert.equal((await search([stashScene]).identify({ names: ["Something.Else.1080p"] })).status, "not-found");
  assert.equal((await search([stashScene, { ...stashScene, id: "s2", title: "Brazzers" }]).identify({ names: ["Brazzers.Beach.2025"] })).status, "ambiguous");
});

test("the registry reports an adult work with studio and performers, without asking TMDB", async () => {
  let tmdbAsked = false;
  const tmdb = new TmdbProvider({ identify: async () => { tmdbAsked = true; return { status: "not-found" }; } });
  const stash = new StashDbProvider({ key: "k", fetch: fakeFetch([{ data: { findScenesBySceneFingerprints: [[stashScene]] } }]), gate });
  const answer = await new MetadataRegistry({ providers: [stash, tmdb] }).identify({ names: ["x"], category: "adult", fingerprint: { hash, size: 1 } });
  assert.equal(answer.status, "identified");
  assert.equal(tmdbAsked, false);
  assert.equal(answer.work.normalized.title, "Brazzers Beach");
  assert.equal(answer.work.normalized.studio, "Brazzers Exxtra");
  assert.equal(answer.work.normalized.adult, true);
  assert.equal(answer.work.normalized.provenance.studio, "stashdb");
});
