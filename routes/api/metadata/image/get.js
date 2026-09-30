/**
 * One TMDB image, for the page.
 *
 * GET /api/metadata/image/:size/:file
 *
 * `size` is one of a fixed list and `file` must look like a TMDB image file
 * name; anything else is 404 without a request going out. The answer carries
 * TMDB's own caching headers, so Cloudflare in front of this server can answer
 * repeats — which is checked after release, not assumed.
 */

import { MetadataUnavailableError } from "../../../../services/metadata/RequestGate.js";
import { IMAGE_FILE, IMAGE_SIZES } from "../../../../services/metadata/ImageFetcher.js";

/**
 * @param {import("fastify").FastifyRequest} req
 * @param {import("fastify").FastifyReply} reply
 * @param {{ images: import("../../../../services/metadata/ImageFetcher.js").ImageFetcher }} deps
 * @returns {Promise<void>}
 */
export async function handleApiMetadataImageGet(req, reply, { images }) {
  const size = String(req.params?.size ?? "");
  const file = String(req.params?.file ?? "");
  if (!IMAGE_SIZES.has(size) || !IMAGE_FILE.test(file)) {
    return reply.code(404).send({ error: "No such image." });
  }
  try {
    const answer = await images.fetch(size, file, {
      ifNoneMatch: req.headers["if-none-match"],
      ifModifiedSince: req.headers["if-modified-since"]
    });
    reply.code(answer.status).headers(answer.headers);
    return answer.body ? reply.send(answer.body) : reply.send();
  } catch (error) {
    if (error instanceof MetadataUnavailableError) {
      // Not cacheable: the next request should try again.
      return reply.code(502).header("cache-control", "no-store").send({ error: error.reason });
    }
    throw error;
  }
}
