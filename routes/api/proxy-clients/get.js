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
 * Return the list of proxy clients that currently have an active tunnel connection.
 * Proxies whose WebSocket tunnel is closed are excluded — they cannot serve video.
 *
 * GET /api/proxy-clients
 *
 * @param {import("fastify").FastifyRequest} _req
 * @param {import("fastify").FastifyReply} reply
 * @param {{ clientsStore: import("../../../store/proxy-clients-store.js").ProxyClientsStore, tunnelServer: import("../../../services/proxy-tunnel-server.js").ProxyTunnelServer }} deps
 * @returns {Promise<void>}
 */
export async function handleApiProxyClientsGet(_req, reply, { clientsStore, tunnelServer }) {
  const clients = clientsStore
    .listClients()
    .filter((client) => tunnelServer.isConnected(client.id))
    .map(toClientSummary);
  return reply.send({ clients });
}
