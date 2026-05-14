/**
 * Docker / Kubernetes readiness probe endpoint.
 * Returns 503 during graceful shutdown so the container is marked unhealthy
 * and removed from rotation before the process exits.
 *
 * GET /healthz
 *
 * @param {import("fastify").FastifyRequest} _req
 * @param {import("fastify").FastifyReply} reply
 * @param {{ shutdownState: { isShuttingDown: boolean } }} deps
 * @returns {Promise<void>}
 */
export async function handleHealthzGet(_req, reply, { shutdownState }) {
  if (shutdownState.isShuttingDown) {
    return reply.code(503).send({
      ok: false,
      status: "shutting_down"
    });
  }

  return reply.send({
    ok: true,
    status: "ok"
  });
}
