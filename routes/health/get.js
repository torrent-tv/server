/**
 * Basic liveness check used by load balancers and orchestrators.
 * Returns 503 during graceful shutdown so traffic stops being routed here.
 *
 * GET /health
 *
 * @param {import("fastify").FastifyRequest} _req
 * @param {import("fastify").FastifyReply} reply
 * @param {{ shutdownState: { isShuttingDown: boolean }, version: string }} deps
 * @returns {Promise<void>}
 */
export async function handleHealthGet(_req, reply, { shutdownState, version }) {
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
    version
  });
}
