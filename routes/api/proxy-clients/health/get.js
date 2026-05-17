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
 * @param {import("fastify").FastifyRequest} _req
 * @param {import("fastify").FastifyReply} reply
 * @param {{ clientsStore: import("../../../../store/proxy-clients-store.js").ProxyClientsStore, tunnelServer: import("../../../../services/proxy-tunnel-server.js").ProxyTunnelServer }} deps
 * @returns {Promise<void>}
 */
export async function handleApiProxyClientsHealthGet(_req, reply, { clientsStore, tunnelServer }) {
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
        rttMs
      };
    })
  );

  return reply.send({ clients });
}
