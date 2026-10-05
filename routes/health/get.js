import { statfs } from "node:fs/promises";

/**
 * Basic liveness check used by load balancers and orchestrators.
 * Returns 503 during graceful shutdown so traffic stops being routed here.
 *
 * Also states the free space of the filesystem holding the server cache, and the
 * part of it the cache keeps free for itself. On the droplet that filesystem also
 * holds Docker's images, so the figure is what the next deployment has to pull a
 * new image into; infra reads it after every deployment and every day
 * (torrent-tv/meta#71). `disk` is null when the server has no cache directory or
 * the filesystem cannot be read.
 *
 * GET /health
 *
 * @param {import("fastify").FastifyRequest} _req
 * @param {import("fastify").FastifyReply} reply
 * @param {{ shutdownState: { isShuttingDown: boolean }, version: string, diskDirectory?: string | null, diskReserveBytes?: number }} deps
 * @returns {Promise<void>}
 */
export async function handleHealthGet(_req, reply, { shutdownState, version, diskDirectory = null, diskReserveBytes = 0 }) {
  if (shutdownState.isShuttingDown) {
    return reply.code(503).send({
      ok: false,
      status: "shutting_down",
      version
    });
  }

  return reply.send({
    ok: true,
    status: "ok",
    version,
    disk: await diskSpace(diskDirectory, diskReserveBytes)
  });
}

/**
 * @param {string | null} directory
 * @param {number} reserveBytes
 * @returns {Promise<{ freeBytes: number, reserveBytes: number } | null>}
 */
async function diskSpace(directory, reserveBytes) {
  if (!directory) return null;
  try {
    const fs = await statfs(directory);
    return { freeBytes: fs.bavail * fs.bsize, reserveBytes };
  } catch {
    return null;
  }
}
