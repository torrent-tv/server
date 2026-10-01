import { normalizeTitle } from "./title.js";
import { aliasCanonicalizer, excludeOtherProperty, filterEvidence, preferContextEvidence, resolveProperties, uniqueEvidence } from "./property-resolution.js";

const reader = (source, path, convert) => ({ source, path, convert });
const scalar = (type, predicate = () => true) => filterEvidence("valid-scalar", candidate =>
  typeof candidate.value === type && predicate(candidate.value), "The observation must have the property's declared shape.");
const number = value => Number(value);
const integer = value => Number.isInteger(value) && value >= 0;
const episodeMarkers = [
  /(?:^|[^a-z0-9])s\d+\s*e(\d+)/ig,
  /(?:^|[^a-z0-9])(?:episode|ep|e)[ ._-]?(\d+)/ig,
  /(?:^|[^\p{L}\d])серия[ ._-]?(\d+)/igu
];

/** Add or reorder rules here; the resolution engine has no property branches. */
export const releasePropertyRules = {
  year: {
    readers: [reader("guessit", "year", number), reader("anitomy", "year", number), reader("filename", "years.from", number)],
    rules: [scalar("number", value => integer(value) && /^\d{4}$/u.test(String(value))),
      preferContextEvidence("filename", "series-start-year", context => context.filename?.years &&
        context.filename.years.from !== context.filename.years.to,
      "A series year span identifies its start year; the final year is not its premiere."), uniqueEvidence]
  },
  season: {
    readers: [reader("guessit", "season", number), reader("anitomy", "season", number)],
    rules: [scalar("number", integer), uniqueEvidence]
  },
  episode: {
    dependsOn: ["year"],
    readers: [reader("guessit", "episode", number), reader("anitomy", "episode.number", number)],
    rules: [scalar("number", value => integer(value) && value > 0),
      excludeOtherProperty("year", (candidate, { context }) =>
        episodeMarkers.some(pattern => [...context.name.matchAll(new RegExp(pattern))].some(match => Number(match[1]) === candidate.value))),
      uniqueEvidence]
  },
  title: {
    readers: [reader("guessit", "title"), reader("anitomy", "title")],
    canonicalize: normalizeTitle,
    rules: [scalar("string", value => value.length > 0), uniqueEvidence]
  },
  resolution: {
    readers: [reader("guessit", "screen_size"), reader("anitomy", "video.resolution")],
    rules: [scalar("string"), uniqueEvidence]
  },
  videoCodec: {
    readers: [reader("guessit", "video_codec"), reader("anitomy", "video.term")],
    canonicalize: aliasCanonicalizer({ "H.264": ["x264", "h264", "avc"], "H.265": ["x265", "h265", "hevc"] }),
    rules: [scalar("string"), uniqueEvidence]
  },
  audioCodec: {
    readers: [reader("guessit", "audio_codec"), reader("anitomy", "audio.term")],
    rules: [scalar("string"), uniqueEvidence]
  },
  releaseGroup: {
    readers: [reader("guessit", "release_group"), reader("anitomy", "release.group")],
    rules: [scalar("string"), uniqueEvidence]
  },
  source: {
    readers: [reader("guessit", "source"), reader("anitomy", "source")],
    canonicalize: aliasCanonicalizer({ Web: ["WEB-DL", "WEBRip"], "Blu-ray": ["BD", "BDRip", "BluRay", "BDRemux"] }),
    rules: [scalar("string"), uniqueEvidence]
  }
};

export function normalizeReleaseSources(sources, name, definitions = releasePropertyRules, context = {}) {
  return resolveProperties(sources, definitions, { ...context, name });
}
