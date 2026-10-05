/**
 * Docker / Kubernetes readiness probe endpoint.
 * Returns 503 during graceful shutdown so the container is marked unhealthy
 * and removed from rotation before the process exits.
 *
 * GET /healthz
 *
 * @param {import("fastify").FastifyRequest} _req
 * @param {import("fastify").FastifyReply} reply
 * @param {{ shutdownState: { isShuttingDown: boolean }, version: string, role?: { describe: () => { state: string, slot: string } } }} deps
 * @returns {Promise<void>}
 */
export async function handleHealthzGet(_req, reply, { shutdownState, version, role }) {
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
    // Which slot this is and whether it serves. Both slots answer ok: one that
    // stands by is healthy, and nginx skips it because every other route
    // answers 503 there.
    instance: role?.describe() ?? null
  });
}
