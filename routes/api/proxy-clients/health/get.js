/**
 * The connected proxies and what each last said about its machine.
 *
 * GET /api/proxy-clients/health
 *
 * Answered from the table each proxy keeps current over its tunnel
 * (torrent-tv/meta#36): nothing is asked of a proxy and nothing is waited for.
 * A proxy that has not said anything yet is listed with `metrics: null`. The
 * films a proxy holds are not listed: they stay on this server, and a page
 * asks `POST /api/proxy-clients/choose` with the film it is opening instead.
 * Read by the deploy checks (`infra/scripts/verify-site.mjs`) to see that the
 * pool is not empty.
 *
 * @param {import("fastify").FastifyRequest} req
 * @param {import("fastify").FastifyReply} reply
 * @param {{ clientsStore: import("../../../../store/proxy-clients-store.js").ProxyClientsStore, tunnelServer: import("../../../../services/proxy-tunnel-server.js").ProxyTunnelServer }} deps
 * @returns {Promise<void>}
 */

import { proxyCandidates, requesterPublicIp } from "../../../../services/proxy-candidates.js";

export async function handleApiProxyClientsHealthGet(req, reply, { clientsStore, tunnelServer }) {
  const clients = proxyCandidates({ clientsStore, tunnelServer, requesterIp: requesterPublicIp(req) })
    .map(({ holdsThisFilm: _holdsThisFilm, ...client }) => client);
  return reply.send({ clients });
}
