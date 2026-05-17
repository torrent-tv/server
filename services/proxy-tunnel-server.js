import { PassThrough } from "node:stream";
import { randomUUID } from "node:crypto";

/** How long to wait for a proxy response before timing out. */
const REQUEST_TIMEOUT_MS = 60_000;

/**
 * @typedef {Object} PendingRequest
 * @property {PassThrough} stream - Readable stream piped into the Fastify reply.
 * @property {import("fastify").FastifyReply} reply - The pending HTTP reply to the browser.
 * @property {boolean} started - Whether `response-start` has been received and headers sent.
 * @property {ReturnType<typeof setTimeout>} timeout - Timeout handle for this request.
 */

/**
 * @typedef {Object} RelayPayload
 * @property {string} method - HTTP method (GET or POST).
 * @property {string} path - Request path on the proxy (e.g. "/health").
 * @property {string} query - Query string without the leading "?".
 * @property {Record<string, string | string[]>} headers - Forwarded request headers.
 * @property {string | null} body - Serialised JSON request body, or null for GET.
 */

/**
 * A WebRTC signal object forwarded between browser and proxy.
 *
 * @typedef {{ type: string, sdp?: string, candidate?: string, mid?: string }} WebRtcSignal
 */

/**
 * Public API of the server-side tunnel manager.
 *
 * @typedef {Object} ProxyTunnelServer
 * @property {(proxyId: string, socket: import("ws").WebSocket) => void} registerConnection
 *   Register (or replace) the WebSocket connection for a proxy.
 * @property {(proxyId: string) => boolean} isConnected
 *   Return true when the proxy has an open tunnel connection.
 * @property {(handler: (sessionId: string, signal: WebRtcSignal) => void) => void} setSignalHandler
 *   Wire up the callback that receives WebRTC signals from proxies.
 *   Called once during server bootstrap.
 * @property {(proxyId: string, timeoutMs?: number) => Promise<{ metrics: import("../../../proxy/services/health-collector.js").HealthMetrics, rttMs: number }>} requestHealth
 *   Send a `health-request` to a proxy and resolve with the response.
 *   `rttMs` is the full tunnel round-trip time.
 * @property {(proxyId: string, sessionId: string, signal: WebRtcSignal) => void} sendSignal
 *   Forward a WebRTC signal from the browser to a proxy.
 * @property {(proxyId: string, payload: RelayPayload, reply: import("fastify").FastifyReply) => Promise<void>} relay
 *   Relay a browser HTTP request to a proxy and stream the response back.
 */

/**
 * Create the server-side WebSocket tunnel manager.
 *
 * Maintains one persistent WebSocket connection per proxy client.
 * When the browser issues a request to `/api/proxy-relay/:id/*`, the
 * relay method forwards it through the matching tunnel connection and
 * streams the response back to the browser without buffering.
 *
 * @returns {ProxyTunnelServer}
 */
export function createProxyTunnelServer() {
  /** @type {Map<string, import("ws").WebSocket>} */
  const connections = new Map();

  /** @type {Map<string, PendingRequest>} */
  const pendingRequests = new Map();

  /**
   * @typedef {Object} PendingHealthRequest
   * @property {(result: { metrics: object, rttMs: number }) => void} resolve
   * @property {(error: Error) => void} reject
   * @property {number} sentAt - `Date.now()` at the time the request was sent.
   */

  /** @type {Map<string, PendingHealthRequest>} */
  const pendingHealthRequests = new Map();

  /**
   * Called when a signal arrives from the proxy side.
   * Set this from the outside (e.g. server.js) to wire up the signal hub.
   *
   * @type {((sessionId: string, signal: object) => void) | null}
   */
  let onSignalFromProxy = null;

  /**
   * Process a single WebSocket message received from a proxy.
   * Routes the message to the correct pending request by requestId,
   * or forwards WebRTC signal messages to the signal hub.
   *
   * @param {Buffer | string} rawData
   * @returns {void}
   */
  function onMessage(rawData) {
    let message;
    try {
      message = JSON.parse(rawData.toString());
    } catch {
      return;
    }

    // Health response from proxy.
    if (message.type === "health-response") {
      const pending = pendingHealthRequests.get(message.requestId);
      if (pending) {
        pendingHealthRequests.delete(message.requestId);
        pending.resolve({ metrics: message.metrics ?? {}, rttMs: Date.now() - pending.sentAt });
      }
      return;
    }

    // WebRTC signalling: forward proxy → browser via signal hub.
    if (message.type === "signal") {
      if (typeof message.sessionId === "string" && message.signal && onSignalFromProxy) {
        onSignalFromProxy(message.sessionId, message.signal);
      }
      return;
    }

    const pendingRequest = pendingRequests.get(message.requestId);
    if (!pendingRequest) {
      return;
    }

    if (message.type === "response-start") {
      if (pendingRequest.started) {
        return;
      }
      pendingRequest.started = true;
      pendingRequest.reply.code(message.status ?? 200);
      for (const [headerName, headerValue] of Object.entries(message.headers ?? {})) {
        if (
          headerName === "transfer-encoding" ||
          headerName === "connection" ||
          headerName === "keep-alive"
        ) {
          continue;
        }
        pendingRequest.reply.header(headerName, headerValue);
      }
      pendingRequest.reply.send(pendingRequest.stream);
      return;
    }

    if (message.type === "response-chunk") {
      if (message.data) {
        pendingRequest.stream.write(Buffer.from(message.data, "base64"));
      }
      if (message.done) {
        clearTimeout(pendingRequest.timeout);
        pendingRequests.delete(message.requestId);
        pendingRequest.stream.end();
      }
      return;
    }

    if (message.type === "response-error") {
      clearTimeout(pendingRequest.timeout);
      pendingRequests.delete(message.requestId);
      if (!pendingRequest.started) {
        pendingRequest.reply.code(502).send({ error: message.error ?? "Proxy error." });
      } else {
        pendingRequest.stream.destroy(new Error(message.error ?? "Proxy error."));
      }
    }
  }

  return {
    /**
     * Register a WebSocket connection for the given proxy ID.
     * If a previous connection exists it is closed and replaced.
     *
     * @param {string} proxyId
     * @param {import("ws").WebSocket} socket
     * @returns {void}
     */
    registerConnection(proxyId, socket) {
      const previousSocket = connections.get(proxyId);
      if (previousSocket && previousSocket.readyState < 2 /* CLOSING */) {
        previousSocket.close(1000, "replaced");
      }
      connections.set(proxyId, socket);
      socket.on("message", onMessage);
      socket.on("close", () => {
        if (connections.get(proxyId) === socket) {
          connections.delete(proxyId);
        }
      });
    },

    /**
     * Return whether the proxy currently has an open tunnel connection.
     *
     * @param {string} proxyId
     * @returns {boolean}
     */
    isConnected(proxyId) {
      const socket = connections.get(proxyId);
      return socket != null && socket.readyState === 1 /* OPEN */;
    },

    /**
     * Wire up the callback that receives WebRTC signals from proxies.
     * Called once during server bootstrap.
     *
     * @param {(sessionId: string, signal: object) => void} handler
     * @returns {void}
     */
    setSignalHandler(handler) {
      onSignalFromProxy = handler;
    },

    /**
     * Request current health metrics from a proxy via its tunnel connection.
     * The returned `rttMs` measures the full tunnel round-trip time.
     *
     * @param {string} proxyId
     * @param {number} [timeoutMs=2000]
     * @returns {Promise<{ metrics: object, rttMs: number }>}
     */
    requestHealth(proxyId, timeoutMs = 2_000) {
      const socket = connections.get(proxyId);
      if (!socket || socket.readyState !== 1 /* OPEN */) {
        return Promise.reject(new Error("Proxy tunnel is not connected."));
      }

      const requestId = randomUUID();
      const sentAt = Date.now();

      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pendingHealthRequests.delete(requestId);
          reject(new Error("Health request timed out."));
        }, timeoutMs);

        pendingHealthRequests.set(requestId, {
          resolve: (result) => { clearTimeout(timer); resolve(result); },
          reject: (err) => { clearTimeout(timer); reject(err); },
          sentAt
        });

        socket.send(JSON.stringify({ type: "health-request", requestId }));
      });
    },

    /**
     * Send a WebRTC signal to a proxy via its tunnel connection.
     * Used to forward SDP offers and ICE candidates from the browser.
     *
     * @param {string} proxyId
     * @param {string} sessionId
     * @param {object} signal
     * @returns {void}
     */
    sendSignal(proxyId, sessionId, signal) {
      const socket = connections.get(proxyId);
      if (socket && socket.readyState === 1 /* OPEN */) {
        socket.send(JSON.stringify({ type: "signal", sessionId, signal }));
      }
    },

    /**
     * Relay a browser HTTP request to the proxy via the tunnel and
     * stream the response back through the Fastify reply.
     *
     * @param {string} proxyId
     * @param {RelayPayload} payload
     * @param {import("fastify").FastifyReply} reply
     * @returns {Promise<void>}
     */
    async relay(proxyId, payload, reply) {
      const socket = connections.get(proxyId);
      if (!socket || socket.readyState !== 1 /* OPEN */) {
        return reply.code(502).send({ error: "Proxy tunnel is not connected." });
      }

      const requestId = randomUUID();
      const responseStream = new PassThrough();

      const timeout = setTimeout(() => {
        const pendingRequest = pendingRequests.get(requestId);
        if (!pendingRequest) {
          return;
        }
        pendingRequests.delete(requestId);
        if (!pendingRequest.started) {
          reply.code(504).send({ error: "Proxy tunnel request timed out." });
        } else {
          responseStream.destroy(new Error("Proxy tunnel request timed out."));
        }
      }, REQUEST_TIMEOUT_MS);

      pendingRequests.set(requestId, {
        stream: responseStream,
        reply,
        started: false,
        timeout
      });

      socket.send(
        JSON.stringify({
          type: "request",
          requestId,
          ...payload
        })
      );
    }
  };
}
