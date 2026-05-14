/**
 * @file Shared logic for relaying browser HTTP requests to a proxy
 * client via the WebSocket tunnel.
 */

/**
 * @typedef {import("fastify").FastifyRequest} FastifyRequest
 * @typedef {import("fastify").FastifyReply} FastifyReply
 * @typedef {ReturnType<import("../../../../../store/proxy-clients-store.js").createProxyClientsStore>} ProxyClientsStore
 * @typedef {ReturnType<import("../../../../../services/proxy-tunnel-server.js").createProxyTunnelServer>} ProxyTunnelServer
 */

/**
 * Headers that must not be forwarded to the proxy.
 * These are connection-level headers that are only meaningful
 * between two adjacent nodes and should not be passed end-to-end.
 */
const HOP_BY_HOP_HEADERS = new Set(["host", "connection", "transfer-encoding"]);

/**
 * Collect headers from the incoming browser request that are safe
 * to forward to the proxy.
 *
 * @param {Record<string, string | string[] | undefined>} incomingHeaders
 * @returns {Record<string, string | string[]>}
 */
function buildForwardHeaders(incomingHeaders) {
  const forwardHeaders = {};
  for (const [headerName, headerValue] of Object.entries(incomingHeaders)) {
    if (HOP_BY_HOP_HEADERS.has(headerName)) {
      continue;
    }
    forwardHeaders[headerName] = headerValue;
  }
  return forwardHeaders;
}

/**
 * Relay an incoming browser request to the proxy identified by
 * the `:id` route parameter, streaming the response back via the
 * WebSocket tunnel.
 *
 * Handles both GET (no body) and POST (JSON body) requests — the
 * method is determined by whichever route calls this function.
 *
 * @param {FastifyRequest} req
 * @param {FastifyReply} reply
 * @param {{ clientsStore: ProxyClientsStore, tunnelServer: ProxyTunnelServer }} deps
 * @returns {Promise<void>}
 */
export async function relayRequestToProxy(req, reply, { clientsStore, tunnelServer }) {
  const { id: proxyId, "*": wildcardPath } = req.params;

  const proxyClient = clientsStore.listClients().find((client) => client.id === proxyId);
  if (!proxyClient) {
    return reply.code(404).send({ error: "Proxy client not found." });
  }

  if (!tunnelServer.isConnected(proxyId)) {
    return reply.code(502).send({ error: "Proxy tunnel is not connected." });
  }

  const path = `/${wildcardPath ?? ""}`;
  const query = new URLSearchParams(req.query).toString();
  const forwardHeaders = buildForwardHeaders(req.headers);
  const body = req.body != null ? JSON.stringify(req.body) : null;

  await tunnelServer.relay(
    proxyId,
    { method: req.method, path, query, headers: forwardHeaders, body },
    reply
  );
}
