import { parseReleaseName } from "./release-name.js";
import { normalizeTitle } from "./title.js";
import { yearOf } from "./adult-http.js";

/** Require a complete parsed title match before using an adult database name result. */
export function matchesAdultNameEvidence(request, scene) {
  const wanted = normalizeTitle(scene?.title);
  if (!wanted || !Array.isArray(request?.names)) return false;
  if (request.kindHint === "tv" || request.episodeNumbers?.length > 0) return false;
  const sceneYear = yearOf(scene?.date ?? scene?.release_date);
  for (const name of request.names.slice(0, 4)) {
    const reading = parseReleaseName(name);
    if (reading.seriesEvidence) continue;
    if (!reading.titles.some(title => normalizeTitle(title) === wanted)) continue;
    const releaseYear = reading.years?.from;
    if (Number.isInteger(releaseYear) && Number.isInteger(sceneYear) && releaseYear !== sceneYear) continue;
    return true;
  }
  return false;
}
