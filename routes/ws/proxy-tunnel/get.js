import { isTokenValid } from "../../../utils/token.js";

/**
 * WebSocket route handler for the proxy tunnel endpoint.
 * Each proxy client connects here once on startup and keeps the
 * connection open for the lifetime of the process.
 *
 * @param {import("ws").WebSocket} socket - The WebSocket connection from the proxy.
 * @param {import("fastify").FastifyRequest} req
 * @param {{ tunnelServer: import("../../../services/proxy-tunnel-server.js").ProxyTunnelServer, serverToken: string }} deps
 * @returns {void}
 */
export function handleWsProxyTunnel(socket, req, { tunnelServer, serverToken }) {
  const clientToken = typeof req.headers["x-proxy-token"] === "string"
    ? req.headers["x-proxy-token"]
    : "";

  if (!isTokenValid(serverToken, clientToken)) {
    socket.close(1008, "Unauthorized");
    return;
  }

  const proxyId = req.headers["x-proxy-id"];
  if (!proxyId || typeof proxyId !== "string" || proxyId.trim().length === 0) {
    socket.close(1008, "x-proxy-id header required");
    return;
  }
  const trimmedProxyId = proxyId.trim();
  console.log(`[tunnel] Proxy connected: ${trimmedProxyId}`);
  tunnelServer.registerConnection(trimmedProxyId, socket);
  socket.on("close", () => {
    console.log(`[tunnel] Proxy disconnected: ${trimmedProxyId}`);
  });
}
