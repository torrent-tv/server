/**
 * The cover of one adult scene, for the page.
 *
 * GET /api/metadata/cover/:source/:id
 *
 * `source` is `theporndb` or `stashdb` and `id` the scene's id; anything else is
 * 404 without a request going out. The address of the image is never taken from
 * the browser (`AdultCovers`).
 */

import { MetadataUnavailableError } from "../../../../services/metadata/RequestGate.js";

/**
 * @param {import("fastify").FastifyRequest} req
 * @param {import("fastify").FastifyReply} reply
 * @param {{ covers: import("../../../../services/metadata/AdultCovers.js").AdultCovers }} deps
 * @returns {Promise<void>}
 */
export async function handleApiMetadataCoverGet(req, reply, { covers }) {
  try {
    const answer = await covers.fetch(String(req.params?.source ?? ""), String(req.params?.id ?? ""));
    if (!answer) return reply.code(404).send({ error: "No such cover." });
    return reply.code(answer.status).headers(answer.headers).send(answer.body);
  } catch (error) {
    if (error instanceof MetadataUnavailableError) {
      return reply.code(502).header("cache-control", "no-store").send({ error: error.reason });
    }
    throw error;
  }
}
