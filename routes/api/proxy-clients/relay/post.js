import { relayRequestToProxy } from "./utils/proxy-relay.js";

/**
 * Handle POST requests that need to be relayed to a proxy client.
 * Covers source registration, playback plan, and transcode session management.
 *
 * @param {import("fastify").FastifyRequest} req
 * @param {import("fastify").FastifyReply} reply
 * @param {{ clientsStore: import("../../../../store/proxy-clients-store.js").ProxyClientsStore, tunnelServer: import("../../../../services/proxy-tunnel-server.js").ProxyTunnelServer }} deps
 * @returns {Promise<void>}
 */
export async function handleProxyRelayPost(req, reply, { clientsStore, tunnelServer }) {
  return relayRequestToProxy(req, reply, { clientsStore, tunnelServer });
}
