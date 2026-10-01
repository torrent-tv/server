import test from "node:test";
import assert from "node:assert/strict";
import { normalizeReleaseSources, releasePropertyRules } from "../services/metadata/release-properties.js";
import { resolveProperties, uniqueEvidence } from "../services/metadata/property-resolution.js";

test("raw observations survive rejection of a year mistaken for an episode", () => {
  const sources = { guessit: Object.freeze({ year: 2026 }), anitomy: Object.freeze({ episode: Object.freeze({ number: 2026 }) }) };
  const result = normalizeReleaseSources(sources, "Film.S01.2026.WEB-DL");
  assert.equal(result.sources, sources);
  assert.equal(result.candidates.episode[0].rawValue, 2026);
  assert.equal(result.normalized.episode, null);
  assert.equal(result.resolutions.episode.status, "rejected");
  assert.equal(result.resolutions.episode.steps[0].rule, "exclude-year-evidence");
});

test("an explicit episode marker supports an episode equal to the year", () => {
  const result = normalizeReleaseSources({ guessit: { year: 2026 }, anitomy: { episode: { number: 2026 } } }, "Anime.S01E2026.2026");
  assert.equal(result.normalized.episode, 2026);
});

test("a large anime episode has no arbitrary upper bound", () => {
  const result = normalizeReleaseSources({ guessit: { episode: 1234 }, anitomy: { episode: { number: 1234 } } }, "Anime - 1234");
  assert.equal(result.normalized.episode, 1234);
  assert.equal(result.resolutions.episode.provenance.length, 2);
});

test("conflicting years cannot silently resolve a possible episode", () => {
  const result = normalizeReleaseSources({ guessit: { year: 2026 }, anitomy: { year: 2025, episode: { number: 2026 } } }, "Film.2026");
  assert.deepEqual(result.conflicts.year, [2026, 2025]);
  assert.equal(result.normalized.episode, null);
  assert.equal(result.resolutions.episode.status, "unresolved");
  assert.deepEqual(result.resolutions.episode.alternatives, [2026]);
});

test("equivalent source and codec labels agree while real disagreements survive", () => {
  const result = normalizeReleaseSources({ guessit: { source: "Web", video_codec: "H.265", screen_size: "1080p" },
    anitomy: { source: "WEB-DL", video: { term: "HEVC", resolution: "720p" } } }, "Film");
  assert.equal(result.normalized.source, "Web");
  assert.equal(result.normalized.videoCodec, "H.265");
  assert.equal(result.normalized.resolution, null);
  assert.deepEqual(result.conflicts.resolution, ["1080p", "720p"]);
});

test("a property registry can add rules without modifying the engine", () => {
  const definitions = { custom: { readers: [{ source: "parser", path: "custom" }], rules: [
    { id: "choose-context", apply: ({ candidates, context }) => ({ candidates: candidates.filter(c => c.value === context.expected), reason: "Explicit external evidence." }) },
    uniqueEvidence
  ] } };
  const result = resolveProperties({ parser: { custom: ["A", "B"] } }, definitions, { expected: "B" });
  assert.equal(result.normalized.custom, "B");
  assert.deepEqual(result.candidates.custom.map(c => c.value), ["A", "B"]);
});

test("dependencies work independently of registry insertion order", () => {
  const definitions = Object.fromEntries(Object.entries(releasePropertyRules).reverse());
  const result = normalizeReleaseSources({ guessit: { year: 2026 }, anitomy: { episode: { number: 2026 } } }, "Film.2026", definitions);
  assert.equal(result.resolutions.episode.status, "rejected");
});

test("invalid registry dependencies are reported", () => {
  assert.throws(() => resolveProperties({}, { a: { dependsOn: ["a"] } }), /Cyclic/);
  assert.throws(() => resolveProperties({}, { a: { dependsOn: ["missing"] } }), /Unknown/);
});
