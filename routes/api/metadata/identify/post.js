/**
 * Which work a release is, from its names.
 *
 * POST /api/metadata/identify
 * body: { names: string[], kindHint: "tv" | "movie" | null, requireYear?: boolean,
 *         episodeEvidence?: { season: number, titles: string[] }, language: string,
 *         category?: "adult" | null, fingerprint?: { hash: string, size: number },
 *         container?: object | null, source?: { infoHash: string, fileIndex: number } | null,
 *         durationSeconds?: number, torrentCreatedAt?: number, episodeNumbers?: { season: number | null, episode }[],
 *         audioLanguages?: string[], record?: { type: "tmdb" | "imdb" | "anilist", id: string, kind?: "movie" | "tv" } }
 *
 * `record` is a work the page already knows (its address carries it): it is
 * looked up, not searched for. `torrentCreatedAt`, `episodeNumbers` and
 * `audioLanguages` are scored when several works share a title
 * (`candidate-score.js`).
 *
 * `container` is what the file states about its work, read by the proxy
 * (`ContainerMetadata.js`); `source` names that file. With both, what the file
 * states is kept by the file; with `source` alone, what was kept is used, so a
 * later viewer of the same file is identified with it at once.
 *
 * Answers `{ status, work?, candidates? }`. Only `identified` carries a work;
 * every other status tells the page to keep showing the release's own names.
 * The limits on the body reject malformed or oversized input; they are not
 * limits on how often a viewer may ask.
 */

import { LANGUAGE, signalOfRequest } from "../request-signal.js";
import { parseReleaseName } from "../../../../services/metadata/release-name.js";
import { fileOf } from "../../../../services/metadata/ContainerRecords.js";
import { readContainerFacts } from "../../../../services/metadata/ContainerMetadata.js";
import { withProviderContext, providerOutcome } from "../../../../services/metadata/provider-diagnostics.js";

/** Most names one request may carry. */
export const MAX_NAMES = 24;

/** Longest name, in characters. */
export const MAX_NAME_LENGTH = 300;

/** Most episode titles sent as evidence. */
export const MAX_EVIDENCE_TITLES = 50;

/** Longest episode title sent as evidence; the proxy sends at most this many characters. */
export const MAX_EVIDENCE_TITLE_LENGTH = 160;

/**
 * Largest body, in bytes: 24 names of 300 characters and 50 titles of 160, and
 * what a container states (nine texts of 300 characters and a description of
 * 2000), each character up to four bytes of UTF-8, with room for the JSON
 * around them.
 */
export const IDENTIFY_BODY_LIMIT = 128 * 1024;

/** Most episode numbers sent as evidence: a long-running series' whole run. */
const MAX_EPISODE_NUMBERS = 1000;

/**
 * The ids a record the page already knows (from its address) names, in the
 * shape the sources look them up by, or `null` when it names none. A TMDB id
 * needs its kind: a film and a series are numbered separately, and one number
 * names two different works.
 *
 * @param {unknown} record
 * @returns {{ tmdb?: { kind: "movie" | "tv", id: number }, imdb?: string, anilist?: number } | null}
 */
function recordIds(record) {
  if (!record || typeof record !== "object") return null;
  const id = String(record.id ?? "");
  if (record.type === "tmdb" && /^[1-9]\d{0,9}$/u.test(id) && (record.kind === "movie" || record.kind === "tv")) {
    return { tmdb: { kind: record.kind, id: Number(id) } };
  }
  if (record.type === "imdb" && /^tt\d{1,10}$/u.test(id)) return { imdb: id };
  if (record.type === "anilist" && /^[1-9]\d{0,9}$/u.test(id)) return { anilist: Number(id) };
  return null;
}

/**
 * @param {import("fastify").FastifyRequest} req
 * @param {import("fastify").FastifyReply} reply
 * @param {{
 *   metadata: import("../../../../services/metadata/MetadataRegistry.js").MetadataRegistry,
 *   containerRecords?: import("../../../../services/metadata/ContainerRecords.js").ContainerRecords
 * }} deps
 * @returns {Promise<void>}
 */
export async function handleApiMetadataIdentifyPost(req, reply, { metadata, containerRecords }) {
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
  const category = body.category ?? null;
  if (category !== null && category !== "adult") {
    return reply.code(400).send({ error: "category must be adult or null." });
  }
  const fingerprint = body.fingerprint ?? null;
  if (fingerprint !== null && !(typeof fingerprint?.hash === "string" && /^[0-9a-f]{16}$/u.test(fingerprint.hash) &&
      Number.isInteger(fingerprint.size) && fingerprint.size > 0)) {
    return reply.code(400).send({ error: "fingerprint must be { hash: 16 hex digits, size: bytes }." });
  }
  const statedContainer = body.container ?? null;
  if (statedContainer !== null && (typeof statedContainer !== "object" || Array.isArray(statedContainer))) {
    return reply.code(400).send({ error: "container must be an object or null." });
  }
  const file = fileOf(body.source);
  if (body.source != null && !file) {
    return reply.code(400).send({ error: "source must be { infoHash: 40 or 64 hex digits, fileIndex }." });
  }
  let container = statedContainer;
  if (file && containerRecords) {
    if (statedContainer) await containerRecords.set(file, statedContainer);
    else container = (await containerRecords.get(file)) ?? null;
  }
  const started = Date.now();
  const durationSeconds = body.durationSeconds ?? null;
  if (durationSeconds !== null && !(typeof durationSeconds === "number" && Number.isFinite(durationSeconds) && durationSeconds > 0 && durationSeconds <= 86_400)) {
    return reply.code(400).send({ error: "durationSeconds must be a positive number of at most 86400 seconds." });
  }
  const torrentCreatedAt = body.torrentCreatedAt ?? null;
  if (torrentCreatedAt !== null && !(Number.isInteger(torrentCreatedAt) && torrentCreatedAt > 0 && torrentCreatedAt <= 4_102_444_800)) {
    return reply.code(400).send({ error: "torrentCreatedAt must be the torrent's creation date in whole seconds since 1970." });
  }
  const episodeNumbers = body.episodeNumbers ?? [];
  if (!(Array.isArray(episodeNumbers) && episodeNumbers.length <= MAX_EPISODE_NUMBERS &&
      episodeNumbers.every((one) => (one?.season === null || (Number.isInteger(one?.season) && one.season >= 0 && one.season <= 999)) &&
        Number.isInteger(one?.episode) && one.episode >= 1 && one.episode <= 9999))) {
    return reply.code(400).send({ error: `episodeNumbers must hold at most ${MAX_EPISODE_NUMBERS} { season, episode } pairs.` });
  }
  const audioLanguages = body.audioLanguages ?? [];
  if (!(Array.isArray(audioLanguages) && audioLanguages.length <= 16 && audioLanguages.every((code) => typeof code === "string" && /^[a-z]{2,3}$/u.test(code)))) {
    return reply.code(400).send({ error: "audioLanguages must hold at most 16 ISO 639 codes." });
  }
  const record = recordIds(body.record);
  if (body.record != null && !record) {
    return reply.code(400).send({ error: "record must be { type: tmdb | imdb | anilist, id, kind?: movie | tv }; a tmdb record needs its kind." });
  }
  const answer = await withProviderContext(req, () => metadata.identify({
    names: names.map((name) => name.trim()).filter((name) => name.length > 0),
    kindHint,
    durationSeconds,
    torrentCreatedAt,
    episodeNumbers,
    audioLanguages,
    ...(record ? { externalIds: record } : {}),
    requireYear: body.requireYear === true,
    episodeEvidence: evidence,
    subtitleEvidence,
    category,
    fingerprint: fingerprint ? { hash: fingerprint.hash, size: fingerprint.size } : undefined,
    container: container ?? undefined,
    language: body.language,
    signal: signalOfRequest(reply)
  }));
  // Counts and the outcome only: the names themselves are not logged.
  withProviderContext(req, () => providerOutcome("metadata", "identify", { status: answer.status, names: names.length,
    container: statedContainer ? "stated" : container ? "kept" : null,
    elapsedMs: Date.now() - started, durationSeconds, tmdbId: answer.work?.sources?.tmdb?.tmdbId ?? answer.work?.tmdbId ?? null,
    selectionReason: answer.work?.sources?.tmdb?.identification ?? answer.work?.identification ?? null }));
  // What the file states goes back as checked, whatever the answer: the page
  // fills its own empty fields from it, and a kept record reaches a page whose
  // proxy has not read the file yet.
  return reply.send({ ...answer, releaseEvidence: names.map(name => parseReleaseName(name)), container: readContainerFacts(container) });
}
