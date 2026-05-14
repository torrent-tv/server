/**
 * Produce a public-facing summary of a proxy client record,
 * omitting any internal fields.
 *
 * @param {import("../../../store/proxy-clients-store.js").ProxyClientRecord} client
 * @returns {{ id: string, name: string, baseUrl: string, createdAt: string, lastSeenAt: string }}
 */
function toClientSummary(client) {
  return {
    id: client.id,
    name: client.name,
    baseUrl: client.baseUrl,
    createdAt: client.createdAt,
    lastSeenAt: client.lastSeenAt
  };
}

/**
 * Return the list of all registered proxy clients.
 *
 * GET /api/proxy-clients
 *
 * @param {import("fastify").FastifyRequest} _req
 * @param {import("fastify").FastifyReply} reply
 * @param {{ clientsStore: import("../../../store/proxy-clients-store.js").ProxyClientsStore }} deps
 * @returns {Promise<void>}
 */
export async function handleApiProxyClientsGet(_req, reply, { clientsStore }) {
  const clients = clientsStore.listClients().map(toClientSummary);
  return reply.send({ clients });
}
