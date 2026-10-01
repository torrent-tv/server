/**
 * Which work a release is, from its names.
 *
 * POST /api/metadata/identify
 * body: { names: string[], kindHint: "tv" | "movie" | null, requireYear?: boolean,
 *         episodeEvidence?: { season: number, titles: string[] }, language: string }
 *
 * Answers `{ status, work?, candidates? }`. Only `identified` carries a work;
 * every other status tells the page to keep showing the release's own names.
 * The limits on the body reject malformed or oversized input; they are not
 * limits on how often a viewer may ask.
 */

import { LANGUAGE, signalOfRequest } from "../request-signal.js";
import { parseReleaseName } from "../../../../services/metadata/release-name.js";

/** Most names one request may carry. */
export const MAX_NAMES = 24;

/** Longest name, in characters. */
export const MAX_NAME_LENGTH = 300;

/** Most episode titles sent as evidence. */
export const MAX_EVIDENCE_TITLES = 50;

/** Longest episode title sent as evidence; the proxy sends at most this many characters. */
export const MAX_EVIDENCE_TITLE_LENGTH = 160;

/**
 * Largest body, in bytes: 24 names of 300 characters and 50 titles of 160, each
 * character up to four bytes of UTF-8, with room for the JSON around them.
 */
export const IDENTIFY_BODY_LIMIT = 64 * 1024;

/**
 * @param {import("fastify").FastifyRequest} req
 * @param {import("fastify").FastifyReply} reply
 * @param {{ metadata: import("../../../../services/metadata/MetadataService.js").MetadataService }} deps
 * @returns {Promise<void>}
 */
export async function handleApiMetadataIdentifyPost(req, reply, { metadata }) {
  const body = req.body ?? {};
  const names = Array.isArray(body.names) ? body.names : null;
  if (!names || names.length === 0 || names.length > MAX_NAMES) {
    return reply.code(400).send({ error: `names must hold 1 to ${MAX_NAMES} strings.` });
  }
  if (names.some((name) => typeof name !== "string" || name.length > MAX_NAME_LENGTH)) {
    return reply.code(400).send({ error: `every name must be a string of at most ${MAX_NAME_LENGTH} characters.` });
  }
  const kindHint = body.kindHint ?? null;
  if (kindHint !== null && kindHint !== "tv" && kindHint !== "movie") {
    return reply.code(400).send({ error: "kindHint must be tv, movie or null." });
  }
  if (body.requireYear !== undefined && typeof body.requireYear !== "boolean") {
    return reply.code(400).send({ error: "requireYear must be a boolean." });
  }
  const evidence = body.episodeEvidence ?? null;
  if (
    evidence !== null &&
    !(
      Number.isInteger(evidence?.season) &&
      evidence.season >= 0 &&
      evidence.season <= 999 &&
      Array.isArray(evidence.titles) &&
      evidence.titles.length <= MAX_EVIDENCE_TITLES &&
      evidence.titles.every((title) => typeof title === "string" && title.length <= MAX_EVIDENCE_TITLE_LENGTH)
    )
  ) {
    return reply.code(400).send({ error: `episodeEvidence must be { season, titles } with at most ${MAX_EVIDENCE_TITLES} titles.` });
  }
  if (typeof body.language !== "string" || !LANGUAGE.test(body.language)) {
    return reply.code(400).send({ error: "language must be a tag such as en-US." });
  }
  const subtitleEvidence = body.subtitleEvidence ?? null;
  if (subtitleEvidence !== null && !(Array.isArray(subtitleEvidence.titles) && subtitleEvidence.titles.length <= 4 &&
      subtitleEvidence.titles.every(title => typeof title === "string" && title.length <= 160) &&
      Array.isArray(subtitleEvidence.years) && subtitleEvidence.years.length <= 4 &&
      subtitleEvidence.years.every(year => Number.isInteger(year) && year >= 1888 && year <= 2100))) {
    return reply.code(400).send({ error: "subtitleEvidence must contain at most four titles and years." });
  }
  const started = Date.now();
  const answer = await metadata.identify({
    names: names.map((name) => name.trim()).filter((name) => name.length > 0),
    kindHint,
    requireYear: body.requireYear === true,
    episodeEvidence: evidence,
    subtitleEvidence,
    language: body.language,
    signal: signalOfRequest(reply)
  });
  // Counts and the outcome only: the names themselves are not logged.
  console.log(`[metadata] identify ${answer.status} names=${names.length} in ${Date.now() - started}ms`);
  return reply.send({ ...answer, releaseEvidence: names.map(name => parseReleaseName(name)) });
}
