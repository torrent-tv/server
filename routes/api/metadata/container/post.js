/**
 * Keep what one file states about its work, for the next viewer of that file.
 *
 * POST /api/metadata/container
 * body: { source: { infoHash: string, fileIndex: number }, container: object }
 *
 * The page sends what its proxy read from the opened file when the work was
 * already established by name, so no identification carries it
 * (`/api/metadata/identify` keeps it whenever one does). The record holds the
 * file's public statements and nothing about who sent them (`ContainerRecords`).
 * Answers `204`.
 */

import { fileOf } from "../../../../services/metadata/ContainerRecords.js";

/** Largest body, in bytes: what a container states, as `/api/metadata/identify` bounds it. */
export const CONTAINER_BODY_LIMIT = 64 * 1024;

/**
 * @param {import("fastify").FastifyRequest} req
 * @param {import("fastify").FastifyReply} reply
 * @param {{ containerRecords: import("../../../../services/metadata/ContainerRecords.js").ContainerRecords }} deps
 * @returns {Promise<void>}
 */
export async function handleApiMetadataContainerPost(req, reply, { containerRecords }) {
  const body = req.body ?? {};
  const file = fileOf(body.source);
  if (!file) return reply.code(400).send({ error: "source must be { infoHash: 40 or 64 hex digits, fileIndex }." });
  const container = body.container;
  if (!container || typeof container !== "object" || Array.isArray(container)) {
    return reply.code(400).send({ error: "container must be an object." });
  }
  await containerRecords.set(file, container);
  return reply.code(204).send();
}
