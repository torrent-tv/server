/**
 * On-demand proxy health poll.
 *
 * The browser calls this endpoint immediately before selecting a proxy for
 * playback.  The server sends a `health-request` to every connected proxy via
 * its tunnel WebSocket, waits up to 2 s for responses, and returns the
 * aggregated list with per-proxy metrics and tunnel round-trip time.
 *
 * Proxies that do not respond within the timeout are still included in the
 * list (with `metrics: null, rttMs: null`) so the caller can fall back to
 * them rather than silently losing options.
 *
 * GET /api/proxy-clients/health
 *
 * @param {import("fastify").FastifyRequest} req
 * @param {import("fastify").FastifyReply} reply
 * @param {{ clientsStore: import("../../../../store/proxy-clients-store.js").ProxyClientsStore, tunnelServer: import("../../../../services/proxy-tunnel-server.js").ProxyTunnelServer }} deps
 * @returns {Promise<void>}
 */

/**
 * Public IP of the requesting browser. The site sits behind Cloudflare,
 * which sets CF-Connecting-IP authoritatively; the X-Forwarded-For first
 * entry and the socket address are dev-mode fallbacks.
 *
 * @param {import("fastify").FastifyRequest} req
 * @returns {string | null}
 */
function getRequesterPublicIp(req) {
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

export async function handleApiProxyClientsHealthGet(req, reply, { clientsStore, tunnelServer }) {
  const requesterIp = getRequesterPublicIp(req);
  const connected = clientsStore
    .listClients()
    .filter((client) => tunnelServer.isConnected(client.id));

  const clients = await Promise.all(
    connected.map(async (client) => {
      let metrics = null;
      let rttMs = null;

      try {
        const result = await tunnelServer.requestHealth(client.id);
        metrics = result.metrics;
        rttMs = result.rttMs;
      } catch {
        // Proxy timed out or disconnected — include it with null metrics.
      }

      return {
        id: client.id,
        name: client.name,
        baseUrl: client.baseUrl,
        createdAt: client.createdAt,
        lastSeenAt: client.lastSeenAt,
        metrics,
        rttMs,
        // Dial-back probe result (null = not probed yet). A false value means
        // the inbound TCP probe failed — NOT that WebRTC cannot connect.
        reachable: client.reachable ?? null,
        // The viewer shares a public IP with the proxy → same network; such a
        // proxy is usable via LAN ICE candidates even when not internet-reachable.
        sameNetwork:
          requesterIp !== null &&
          typeof client.endpoint?.externalIp === "string" &&
          client.endpoint.externalIp === requesterIp
      };
    })
  );

  return reply.send({ clients });
}
