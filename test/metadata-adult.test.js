import test from "node:test";
import assert from "node:assert/strict";
import { MetadataRegistry } from "../services/metadata/MetadataRegistry.js";
import { TmdbProvider } from "../services/metadata/TmdbProvider.js";
import { ThePornDbProvider } from "../services/metadata/ThePornDbProvider.js";
import { StashDbProvider } from "../services/metadata/StashDbProvider.js";
import { AdultCovers } from "../services/metadata/AdultCovers.js";

const gate = { run: task => task(), pause() {} };
const hash = "8e245d9679d31e12";

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** A fetch that answers from a list and records what it was asked. */
function fakeFetch(answers, seen = []) {
  return async (url, init) => { seen.push({ url: String(url), init }); return json(answers.shift()); };
}

const tpdbScene = { id: "abc", title: "Geography Test", date: "2007-03-30", description: "text", site: { name: "Oldje" }, performers: [{ name: "A" }, { name: "B" }] };
const stashScene = { id: "s1", title: "Brazzers Beach", details: null, release_date: "2025-07-15", studio: { name: "Brazzers Exxtra" }, performers: [{ performer: { name: "Angela" } }] };

test("ThePornDB identifies by the file hash first and reduces the scene to the common fields", async () => {
  const seen = [];
  const provider = new ThePornDbProvider({ key: "secret-key", fetch: fakeFetch([{ data: [tpdbScene] }], seen), gate });
  const answer = await provider.identify({ names: ["whatever"], fingerprint: { hash, size: 1 } });
  assert.equal(answer.status, "identified");
  assert.match(seen[0].url, /hash=8e245d9679d31e12&hashType=OSHASH/);
  assert.equal(seen[0].init.headers.Authorization, "Bearer secret-key");
  assert.deepEqual(provider.fields(answer.records.theporndb), { kind: "movie", title: "Geography Test", year: 2007, overview: "text", poster: undefined, studio: "Oldje", performers: ["A", "B"], adult: true });
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

/** A registry over a fake general source and a fake adult one, recording who was asked and with what. */
function ordered({ general, adult }) {
  const asked = [];
  const tmdb = new TmdbProvider({ identify: async request => { asked.push(["general", request.names]); return general; } });
  const stash = new StashDbProvider({ key: "k", gate, fetch: async (url, init) => {
    const { variables } = JSON.parse(init.body);
    asked.push(["adult", variables.f ? "hash" : "name"]);
    return json(variables.f ? { data: { findScenesBySceneFingerprints: [adult.hash ?? []] } } : { data: { searchScene: adult.name ?? [] } });
  } });
  return { asked, registry: new MetadataRegistry({ providers: [stash, tmdb] }) };
}

const film = { status: "identified", work: { tmdbId: 7, kind: "movie", title: "A Film", year: 2001, seasons: [], images: [] } };

test("the hash is asked first, whatever the category, and an exact match ends the questions", async () => {
  const { asked, registry } = ordered({ general: film, adult: { hash: [stashScene] } });
  const answer = await registry.identify({ names: ["A Film 2001"], fingerprint: { hash, size: 1 } });
  assert.equal(answer.work.normalized.title, "Brazzers Beach");
  assert.deepEqual(asked, [["adult", "hash"]]);
});

test("without a stated category the general databases come first and the adult ones are left alone when they know the name", async () => {
  const { asked, registry } = ordered({ general: film, adult: {} });
  const answer = await registry.identify({ names: ["A Film 2001"] });
  assert.equal(answer.work.normalized.title, "A Film");
  assert.deepEqual(asked.map(([kind]) => kind), ["general"]);
});

test("when the film and anime databases find nothing, the adult ones are asked even without a category", async () => {
  const { asked, registry } = ordered({ general: { status: "not-found" }, adult: { name: [stashScene] } });
  const answer = await registry.identify({ names: ["Brazzers.Beach.2025.1080p.mp4"] });
  assert.equal(answer.status, "identified");
  assert.equal(answer.work.normalized.studio, "Brazzers Exxtra");
  assert.deepEqual(asked.map(([kind]) => kind), ["general", "adult"]);
});

test("several candidates in the general databases are an answer: the adult ones are not asked then", async () => {
  const { asked, registry } = ordered({ general: { status: "ambiguous", candidates: [] }, adult: { name: [stashScene] } });
  const answer = await registry.identify({ names: ["Brazzers.Beach.2025"] });
  assert.equal(answer.status, "ambiguous");
  assert.deepEqual(asked.map(([kind]) => kind), ["general"]);
});

test("a stated adult category asks the adult databases first and the general ones only when they found nothing", async () => {
  const hit = ordered({ general: film, adult: { name: [stashScene] } });
  assert.equal((await hit.registry.identify({ names: ["Brazzers.Beach.2025"], category: "adult" })).work.normalized.title, "Brazzers Beach");
  assert.deepEqual(hit.asked.map(([kind]) => kind), ["adult"]);
  const miss = ordered({ general: film, adult: {} });
  assert.equal((await miss.registry.identify({ names: ["A Film 2001"], category: "adult" })).work.normalized.title, "A Film");
  assert.deepEqual(miss.asked.map(([kind]) => kind), ["adult", "general"]);
});

const sceneId = "1703a150-ceec-4953-ac10-d7ebc7d0974f";
const png = () => new Response(new Uint8Array([137, 80, 78, 71]), { status: 200, headers: { "content-type": "image/png" } });

test("a scene with an image states its cover as this server's own route", () => {
  assert.equal(new StashDbProvider({ key: "k", gate }).fields({ ...stashScene, id: sceneId, images: [{ url: "x" }] }).poster, `/api/metadata/cover/stashdb/${sceneId}`);
  assert.equal(new StashDbProvider({ key: "k", gate }).fields(stashScene).poster, undefined);
  assert.equal(new ThePornDbProvider({ key: "k", gate }).fields({ ...tpdbScene, id: sceneId, image: "https://studio.example/y.jpg" }).poster, undefined, "the studio page is not a cover");
  assert.equal(new ThePornDbProvider({ key: "k", gate }).fields({ ...tpdbScene, id: sceneId, image: "https://studio.example/y.jpg", background: { large: "https://cdn.theporndb.net/a.jpg" } }).poster, `/api/metadata/cover/theporndb/${sceneId}`);
});

test("the cover is fetched from the database's own hosts only, as an image, and refuses anything else", async () => {
  const asked = [];
  const make = (url, image = png) => new AdultCovers({
    providers: [{ name: "stashdb", coverUrl: async () => url }],
    fetch: async (address) => { asked.push(String(address)); return image(); }
  });
  const ok = await make("https://stashdb.org/images/abc").fetch("stashdb", sceneId);
  assert.equal(ok.headers["content-type"], "image/png");
  assert.match(ok.headers["cache-control"], /max-age=86400/);
  assert.deepEqual(asked, ["https://stashdb.org/images/abc"]);
  assert.equal(await make("https://evil.example/x.png").fetch("stashdb", sceneId), null);
  assert.equal(await make("http://stashdb.org/images/abc").fetch("stashdb", sceneId), null);
  assert.equal(await make("https://stashdb.org.evil.example/a").fetch("stashdb", sceneId), null);
  assert.equal(await make("https://thumb.theporndb.net/a.webp").fetch("unknown", sceneId), null);
  assert.equal(await make("https://thumb.theporndb.net/a.webp").fetch("stashdb", "../etc/passwd"), null);
  await assert.rejects(make("https://stashdb.org/images/abc", () => new Response("<html>", { headers: { "content-type": "text/html" } })).fetch("stashdb", sceneId), /not an image/);
  assert.equal(asked.length, 2, "only the two allowed addresses were requested");
});

test("the page takes a cover route as an image and nothing else of that shape", async () => {
  const { imageUrl } = await import("../public/domain/media-info.js");
  assert.equal(imageUrl("w500", `/api/metadata/cover/stashdb/${sceneId}`), `/api/metadata/cover/stashdb/${sceneId}`);
  assert.equal(imageUrl("w500", "/api/metadata/cover/evil/abc"), null);
  assert.equal(imageUrl("w500", `/api/metadata/cover/stashdb/${sceneId}/../x`), null);
  assert.equal(imageUrl("w500", "abcdefgh12.jpg"), "/api/metadata/image/w500/abcdefgh12.jpg");
});

test("the cover of the scene that was found becomes the poster of the work", async () => {
  const scene = { ...stashScene, id: sceneId, images: [{ url: "https://stashdb.org/images/x" }] };
  const stash = new StashDbProvider({ key: "k", gate, fetch: fakeFetch([{ data: { findScenesBySceneFingerprints: [[scene]] } }]) });
  const answer = await new MetadataRegistry({ providers: [stash] }).identify({ names: ["x"], fingerprint: { hash, size: 1 } });
  assert.equal(answer.work.normalized.poster, `/api/metadata/cover/stashdb/${sceneId}`);
  assert.equal(answer.work.normalized.provenance.poster, "stashdb");
});

test("ThePornDB's cover is the background or the poster on its own hosts, never the studio's page", async () => {
  const answer = (data) => new ThePornDbProvider({ key: "k", gate, fetch: fakeFetch([{ data }]) }).coverUrl(sceneId);
  assert.equal(await answer({ image: "https://studio.example/a.jpg", background: { large: "https://cdn.theporndb.net/b.jpg", full: "https://cdn.theporndb.net/c.jpg" }, poster: "https://thumb.theporndb.net/p.jpg" }), "https://cdn.theporndb.net/b.jpg");
  assert.equal(await answer({ image: "https://studio.example/a.jpg", poster: "https://thumb.theporndb.net/p.jpg" }), "https://thumb.theporndb.net/p.jpg");
  assert.equal(await answer({ image: "https://studio.example/a.jpg" }), null);
});
