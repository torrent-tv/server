/**
 * @file The connected proxies as a choice sees them: the table each proxy keeps
 * current over its tunnel, joined with what this server knows itself.
 */

/**
 * Public IP of the requesting browser. The site sits behind Cloudflare, which
 * sets CF-Connecting-IP authoritatively; the X-Forwarded-For first entry and
 * the socket address are dev-mode fallbacks.
 *
 * @param {import("fastify").FastifyRequest} req
 * @returns {string | null}
 */
export function requesterPublicIp(req) {
  const cf = req.headers["cf-connecting-ip"];
  if (typeof cf === "string" && cf.trim().length > 0) {
    return cf.trim();
  }
  const xff = req.headers["x-forwarded-for"];
  if (typeof xff === "string" && xff.trim().length > 0) {
    return xff.split(",")[0].trim();
  }
  return typeof req.ip === "string" && req.ip.length > 0 ? req.ip : null;
}

/**
 * Every proxy with an open tunnel, as a candidate for one viewer and one film.
 *
 * @param {object} params
 * @param {import("../store/proxy-clients-store.js").ProxyClientsStore} params.clientsStore
 * @param {import("./proxy-tunnel-server.js").ProxyTunnelServer} params.tunnelServer
 * @param {string | null} params.requesterIp
 * @param {string} [params.infoHash] - The film about to be opened; "" when none yet.
 * @returns {import("./proxy-choice.js").Candidate[]}
 */
export function proxyCandidates({ clientsStore, tunnelServer, requesterIp, infoHash = "" }) {
  clientsStore.pruneDisconnected({ isConnected: (id) => tunnelServer.isConnected(id) });
  const wanted = infoHash.toLowerCase();
  return clientsStore
    .listClients()
    .filter((client) => tunnelServer.isConnected(client.id))
    .map((client) => {
      const state = tunnelServer.stateOf(client.id);
      return {
        id: client.id,
        name: client.name,
        baseUrl: client.baseUrl,
        metrics: state?.metrics ?? null,
        rttMs: state?.rttMs ?? null,
        // Dial-back probe result (null = not probed yet). False means the
        // inbound TCP probe failed — NOT that WebRTC cannot connect.
        reachable: client.reachable ?? null,
        // The viewer shares a public IP with the proxy: same network, usable
        // via LAN ICE candidates even when not reachable from the internet.
        sameNetwork: requesterIp !== null && typeof client.endpoint?.externalIp === "string" &&
          client.endpoint.externalIp === requesterIp,
        holdsThisFilm: wanted.length > 0 &&
          (state?.holds ?? []).some((held) => String(held?.infoHash ?? "").toLowerCase() === wanted)
      };
    });
}
