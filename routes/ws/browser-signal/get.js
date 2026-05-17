/**
 * WebSocket route handler for browser-side WebRTC signalling.
 *
 * The browser connects here to exchange SDP offers/answers and ICE
 * candidates with a proxy. The server acts as a pure relay — it never
 * inspects the WebRTC payloads, only routes them by sessionId.
 *
 * Flow:
 *   1. Browser connects → server sends { type: "session", sessionId }
 *   2. Browser sends   { type: "offer",     proxyId, sdp }
 *   3. Server forwards to proxy via tunnel: { type: "signal", sessionId, signal: { type: "offer", sdp } }
 *   4. Proxy replies via tunnel:            { type: "signal", sessionId, signal: { type: "answer", sdp } }
 *   5. Server forwards to browser:          { type: "answer", sdp }
 *   6. ICE candidates flow the same way in both directions.
 *
 * @param {import("ws").WebSocket} socket
 * @param {import("fastify").FastifyRequest} _req
 * @param {{ signalHub: import("../../../services/signal-hub.js").SignalHub, tunnelServer: import("../../../services/proxy-tunnel-server.js").ProxyTunnelServer }} deps
 * @returns {void}
 */
export function handleWsBrowserSignal(socket, _req, { signalHub, tunnelServer }) {
  signalHub.registerBrowser(socket, (sessionId, proxyId, signal) => {
    tunnelServer.sendSignal(proxyId, sessionId, signal);
  });
}
