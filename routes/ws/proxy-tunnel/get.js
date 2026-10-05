import { isTokenValid } from "../../../utils/token.js";

/**
 * Read a header that may be absent or repeated as one string.
 *
 * @param {import("fastify").FastifyRequest} req
 * @param {string} name
 * @returns {string}
 */
function headerOf(req, name) {
  const value = req.headers[name];
  return typeof value === "string" ? value : "";
}

/**
 * WebSocket route handler for the proxy tunnel endpoint.
 * Each proxy client connects here once on startup and keeps the
 * connection open for the lifetime of the process.
 *
 * A proxy that sends its name with the connection is registered from the
 * connection itself. During a server release its separate registration
 * request may reach the other server instance, and the instance that holds
 * the tunnel must know the proxy without it.
 *
 * @param {import("ws").WebSocket} socket - The WebSocket connection from the proxy.
 * @param {import("fastify").FastifyRequest} req
 * @param {{ tunnelServer: import("../../../services/proxy-tunnel-server.js").ProxyTunnelServer, clientsStore: import("../../../store/proxy-clients-store.js").ProxyClientsStore, serverToken: string }} deps
 * @returns {void}
 */
export function handleWsProxyTunnel(socket, req, { tunnelServer, clientsStore, serverToken }) {
  const clientToken = headerOf(req, "x-proxy-token");

  if (!isTokenValid(serverToken, clientToken)) {
    socket.close(1008, "Unauthorized");
    return;
  }

  const trimmedProxyId = headerOf(req, "x-proxy-id").trim();
  if (trimmedProxyId.length === 0) {
    socket.close(1008, "x-proxy-id header required");
    return;
  }

  const encodedName = headerOf(req, "x-proxy-name");
  if (encodedName) {
    let name = encodedName;
    try {
      name = decodeURIComponent(encodedName);
    } catch {
      // silent-ok: a name that is not valid percent-encoding is shown as sent.
    }
    clientsStore.upsertClient({ id: trimmedProxyId, name, baseUrl: headerOf(req, "x-proxy-base-url") });
  }

  const followsMoves = headerOf(req, "x-proxy-follows-moves") === "1";
  console.log(`[tunnel] Proxy connected: ${trimmedProxyId}${followsMoves ? " (follows moves)" : ""}`);
  tunnelServer.registerConnection(trimmedProxyId, socket, { followsMoves });
  socket.on("close", () => {
    console.log(`[tunnel] Proxy disconnected: ${trimmedProxyId}`);
  });
}
