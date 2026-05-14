import { isTokenValid } from "../../../../utils/token.js";

/**
 * Extract a plain object from the request body, guarding against
 * non-object payloads (arrays, primitives, null).
 *
 * @param {unknown} body
 * @returns {Record<string, unknown>}
 */
function getPayload(body) {
  if (body && typeof body === "object" && !Array.isArray(body)) {
    return body;
  }
  return {};
}

/**
 * Record a heartbeat from an already-registered proxy client.
 * Refreshes `lastSeenAt` so the server knows the proxy is still alive.
 *
 * POST /api/proxy-clients/heartbeat
 *
 * @param {import("fastify").FastifyRequest} req
 * @param {import("fastify").FastifyReply} reply
 * @param {{ clientsStore: import("../../../../store/proxy-clients-store.js").ProxyClientsStore, serverToken: string }} deps
 * @returns {Promise<void>}
 */
export async function handleApiProxyClientsHeartbeatPost(req, reply, { clientsStore, serverToken }) {
  const clientToken = typeof req.headers["x-proxy-token"] === "string"
    ? req.headers["x-proxy-token"]
    : "";

  if (!isTokenValid(serverToken, clientToken)) {
    return reply.code(401).send({ error: "Unauthorized." });
  }

  const payload = getPayload(req.body);
  const { id } = payload;

  if (typeof id !== "string") {
    return reply.code(400).send({ error: "Client id is required." });
  }

  const touched = clientsStore.touchClient(id);
  if (!touched) {
    return reply.code(404).send({ error: "Client is not registered." });
  }

  return reply.send({ ok: true });
}
