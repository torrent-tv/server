import test from "node:test";
import assert from "node:assert/strict";
import { parseReleaseName } from "../services/metadata/release-name.js";

test("release metadata continues after the season boundary", () => {
  const result = parseReleaseName("Trudno.byt.bogom.S01.2026.WEB-DL.1080p.ExKinoRay");
  assert.deepEqual(result.titles, ["Trudno byt bogom"]);
  assert.deepEqual(result.years, { from: 2026, to: 2026 });
  assert.equal(result.release.normalized.year, 2026);
  assert.equal(result.release.normalized.season, 1);
  assert.equal(result.release.normalized.episode, null);
  assert.equal(result.release.normalized.resolution, "1080p");
  assert.equal(result.release.normalized.releaseGroup, "ExKinoRay");
  assert.ok(result.release.sources.anitomy);
  assert.ok(result.release.sources.guessit);
});

test("technical episode tails carry evidence rather than a title", () => {
  const result = parseReleaseName("2026.WEB-DL.1080p.ExKinoRay");
  assert.deepEqual(result.titles, []);
  assert.equal(result.years.from, 2026);
  assert.equal(result.release.sources.guessit.source, "Web");
});

test("numeric movie titles and explicit year spans stay intact", () => {
  assert.deepEqual(parseReleaseName("2012.2009.1080p.mkv").titles, ["2012"]);
  assert.deepEqual(parseReleaseName("Poirot.1989-2013.hdrip_[teko]").years, { from: 1989, to: 2013 });
  const span = parseReleaseName("Poirot.1989-2013.hdrip_[teko]").release;
  assert.equal(span.normalized.year, 1989);
  assert.ok(span.resolutions.year.steps.some(step => step.rule === "series-start-year"));
});

test("anime parsers preserve episode and codec evidence", () => {
  const result = parseReleaseName("[Judas] Drifters - 01 [1080p][H.265].mkv");
  assert.equal(result.release.sources.anitomy.title, "Drifters");
  assert.equal(result.release.sources.anitomy.episode.number, 1);
  assert.equal(result.release.normalized.videoCodec, "H.265");
});
