/**
 * Which episode of one season each file of a release is.
 *
 * POST /api/metadata/episodes
 * body: { tmdbId, season, language, files: [{ key, episodes, part?, special?, titleHint? }] }
 *
 * `files` must be EVERY file of the release in that season: whether a number
 * alone may be trusted is decided over the whole season, so a subset would get
 * an answer that depends on what else was sent. This is also the one place the
 * server is told part of a release's contents — the episode numbers and title
 * hints of one season — and it keeps none of it after answering.
 *
 * A season larger than the limits below is refused whole, never split: split,
 * a conflict in one half could not stop a number being trusted in the other.
 */

import { LANGUAGE, signalOfRequest } from "../request-signal.js";

/** Most files in one season. */
export const MAX_SEASON_FILES = 1000;

/** Longest page key, in characters. */
export const MAX_KEY_LENGTH = 16;

/** Longest title hint, in characters — the proxy sends at most this many. */
export const MAX_TITLE_HINT_LENGTH = 160;

/** Most episode numbers one file may carry — the proxy reads at most this many. */
export const MAX_EPISODES_PER_FILE = 8;

/**
 * Largest body, in bytes. One file is at most a 16-character key, a
 * 160-character hint (up to 640 bytes of UTF-8), eight numbers and the JSON
 * around them — under 900 bytes — so 1000 of them fit.
 */
export const EPISODES_BODY_LIMIT = 1024 * 1024;

/**
 * @param {unknown} file
 * @returns {boolean}
 */
function validFile(file) {
  if (!file || typeof file !== "object") {
    return false;
  }
  const { key, episodes, part = null, special = false, titleHint = "" } = /** @type {any} */ (file);
  return (
    typeof key === "string" &&
    key.length > 0 &&
    key.length <= MAX_KEY_LENGTH &&
    Array.isArray(episodes) &&
    episodes.length > 0 &&
    episodes.length <= MAX_EPISODES_PER_FILE &&
    episodes.every((number) => Number.isInteger(number) && number >= 0 && number <= 9999) &&
    (part === null || (Number.isInteger(part) && part >= 1 && part <= 99)) &&
    typeof special === "boolean" &&
    typeof titleHint === "string" &&
    titleHint.length <= MAX_TITLE_HINT_LENGTH
  );
}

/**
 * @param {import("fastify").FastifyRequest} req
 * @param {import("fastify").FastifyReply} reply
 * @param {{ metadata: import("../../../../services/metadata/MetadataService.js").MetadataService }} deps
 * @returns {Promise<void>}
 */
export async function handleApiMetadataEpisodesPost(req, reply, { metadata }) {
  const body = req.body ?? {};
  if (!Number.isInteger(body.tmdbId) || body.tmdbId <= 0) {
    return reply.code(400).send({ error: "tmdbId must be a positive integer." });
  }
  if (!Number.isInteger(body.season) || body.season < 0 || body.season > 999) {
    return reply.code(400).send({ error: "season must be an integer from 0 to 999." });
  }
  if (typeof body.language !== "string" || !LANGUAGE.test(body.language)) {
    return reply.code(400).send({ error: "language must be a tag such as en-US." });
  }
  const files = Array.isArray(body.files) ? body.files : null;
  if (!files || files.length === 0 || files.length > MAX_SEASON_FILES) {
    return reply
      .code(413)
      .send({ error: `files must hold 1 to ${MAX_SEASON_FILES} entries; the season is left unmatched.` });
  }
  if (!files.every(validFile) || new Set(files.map((file) => file.key)).size !== files.length) {
    return reply.code(400).send({ error: "every file needs a unique key, episode numbers and valid optional fields." });
  }
  const started = Date.now();
  const answer = await metadata.episodes({
    tmdbId: body.tmdbId,
    season: body.season,
    language: body.language,
    files: files.map((file) => ({
      key: file.key,
      episodes: file.episodes,
      part: file.part ?? null,
      special: file.special === true,
      titleHint: file.titleHint ?? ""
    })),
    signal: signalOfRequest(reply)
  });
  const matched = answer.files?.filter((file) => file.status === "matched").length ?? 0;
  console.log(`[metadata] episodes ${answer.status} matched=${matched}/${files.length} in ${Date.now() - started}ms`);
  return reply.send(answer);
}
