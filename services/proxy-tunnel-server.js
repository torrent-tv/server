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
 * @typedef {Object} ProxyTunnelServer
 * @property {(proxyId: string, socket: import("ws").WebSocket) => void} registerConnection
 * @property {(proxyId: string) => boolean} isConnected
 * @property {(proxyId: string, payload: RelayPayload, reply: import("fastify").FastifyReply) => Promise<void>} relay
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
   * Process a single WebSocket message received from a proxy.
   * Routes the message to the correct pending request by requestId.
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
