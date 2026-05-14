import { relayRequestToProxy } from "./utils/proxy-relay.js";

/**
 * Handle GET requests that need to be relayed to a proxy client.
 * Covers health checks, stream, HLS segments, and transcode progress.
 *
 * @param {import("fastify").FastifyRequest} req
 * @param {import("fastify").FastifyReply} reply
 * @param {{ clientsStore: import("../../../../store/proxy-clients-store.js").ProxyClientsStore, tunnelServer: import("../../../../services/proxy-tunnel-server.js").ProxyTunnelServer }} deps
 * @returns {Promise<void>}
 */
export async function handleProxyRelayGet(req, reply, { clientsStore, tunnelServer }) {
  return relayRequestToProxy(req, reply, { clientsStore, tunnelServer });
}
