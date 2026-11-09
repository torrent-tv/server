import { randomUUID } from "node:crypto";

/**
 * A WebRTC signal object forwarded between browser and proxy.
 *
 * @typedef {{ type: string, sdp?: string, candidate?: string, mid?: string }} WebRtcSignal
 */

/**
 * Public API of the server-side tunnel manager.
 *
 * @typedef {Object} ProxyTunnelServer
 * @property {(proxyId: string, socket: import("ws").WebSocket, options?: { followsMoves?: boolean }) => void} registerConnection
 *   Register (or replace) the WebSocket connection for a proxy. `followsMoves`
 *   says the proxy opens a new connection when asked to move and answers each
 *   request on the connection it arrived on.
 * @property {() => { proxyId: string, followsMoves: boolean }[]} connectedProxies
 *   Every proxy with an open tunnel connection now.
 * @property {(options?: { signal?: AbortSignal }) => Promise<void>} waitForFirstConnection
 *   Resolve when a proxy tunnel is connected, or reject when the caller aborts.
 * @property {(proxyId: string) => void} askToMove
 *   Ask a proxy to open a connection to the server instance that replaces this one.
 * @property {(code: number, reason: string) => void} closeAll
 *   Close every tunnel connection.
 * @property {(handler: (proxyId: string, connected: boolean) => void) => void} setConnectionHandler
 *   Wire up the callback told when a proxy's tunnel opens or closes.
 * @property {(proxyId: string) => boolean} isConnected
 *   Return true when the proxy has an open tunnel connection.
 * @property {(handler: (sessionId: string, signal: WebRtcSignal) => void) => void} setSignalHandler
 *   Wire up the callback that receives WebRTC signals from proxies.
 *   Called once during server bootstrap.
 * @property {(handler: (proxyId: string, endpoint: { externalIp: string | null, externalPort: number, protocol: string }) => void) => void} setEndpointHandler
 *   Wire up the callback that receives `proxy-endpoint` reports (the UPnP-mapped
 *   external endpoint). Called once during server bootstrap.
 * @property {(proxyId: string) => ProxyState | null} stateOf
 *   What a connected proxy last said about itself (`proxy-state`), with the
 *   tunnel round trip last measured; `null` before it has said anything.
 * @property {(proxyId: string, mediaInfo: object, timeoutMs?: number) => Promise<{ offer: { copy: number[], transcode: number[] } | null, rttMs: number }>} requestCanServe
 *   Ask a proxy whether it could sustain a file it is only told about.
 * @property {(proxyId: string, sessionId: string, signal: WebRtcSignal) => void} sendSignal
 *   Forward a WebRTC signal from the browser to a proxy.
 */

/**
 * What a proxy said about itself (`proxy-state`).
 *
 * @typedef {Object} ProxyState
 * @property {{ cpuLoad?: number, memFree?: number, encodeSpeedX?: number | null, encodeOccupiedCostSec?: number }} metrics
 * @property {{ infoHash: string, progress: number | null, bytes: number, wholeFiles?: number[] }[]} holds - The films it holds.
 * @property {number} receivedAt - When it said it.
 * @property {number | null} rttMs - The tunnel round trip last measured.
 */

/**
 * Create the server-side WebSocket tunnel manager.
 *
 * Maintains one persistent WebSocket connection per proxy client, which
 * carries WebRTC signalling, can-serve questions and the proxy's state.
 *
 * @returns {ProxyTunnelServer}
 */
export function createProxyTunnelServer() {
  /** @type {Map<string, import("ws").WebSocket>} */
  const connections = new Map();
  /**
   * What each connected proxy last said about itself: its load and free
   * memory, its room for one more encode, and the films it holds. The proxy
   * sends it when it changes (proxy `transport/proxy-state.js`), so a proxy
   * choice reads it here instead of asking every proxy and waiting
   * (torrent-tv/meta#36). Forgotten with the proxy's connection.
   *
   * @type {Map<string, ProxyState>}
   */
  const states = new Map();
  /** The last tunnel round trip measured, per proxy. @type {Map<string, number>} */
  const roundTrips = new Map();
  /**
   * The connections whose proxy follows a move (see `registerConnection`).
   *
   * @type {WeakSet<import("ws").WebSocket>}
   */
  const followingMoves = new WeakSet();

  const connectedProxies = () => {
    const proxies = [];
    for (const [proxyId, socket] of connections) {
      if (socket.readyState === 1 /* OPEN */) {
        proxies.push({ proxyId, followsMoves: followingMoves.has(socket) });
      }
    }
    return proxies;
  };

  /**
   * Called when a proxy's tunnel opens or closes. Set from server.js.
   *
   * @type {((proxyId: string, connected: boolean) => void) | null}
   */
  let onConnectionChange = null;

  /** @type {Set<() => void>} */
  const firstConnectionWaiters = new Set();

  /**
   * @typedef {Object} PendingHealthRequest
   * @property {(result: { offer: object | null, rttMs: number }) => void} resolve
   * @property {(error: Error) => void} reject
   * @property {number} sentAt - `Date.now()` at the time the request was sent.
   */

  /**
   * In-flight "could you serve this file" questions, by request id.
   *
   * Separate from the health ones because they answer a different question:
   * health is about the machine, this is about the machine AND one file. A
   * proxy can be idle and still unable to sustain a 4K HEVC source, and busy
   * yet perfectly able to copy a 480p one.
   *
   * @type {Map<string, PendingHealthRequest>}
   */
  const pendingCanServeRequests = new Map();

  /**
   * Called when a signal arrives from the proxy side.
   * Set this from the outside (e.g. server.js) to wire up the signal hub.
   *
   * @type {((sessionId: string, signal: object) => void) | null}
   */
  let onSignalFromProxy = null;

  /**
   * Called when a proxy reports its UPnP-mapped external endpoint.
   * Set from the outside (server.js) to trigger the dial-back probe.
   *
   * @type {((proxyId: string, endpoint: { externalIp: string | null, externalPort: number, protocol: string }) => void) | null}
   */
  let onEndpointFromProxy = null;

  /**
   * Process a single WebSocket message received from a proxy.
   * Routes the message to the correct pending request by requestId,
   * or forwards WebRTC signal / endpoint messages to their handlers.
   *
   * @param {Buffer | string} rawData
   * @param {string} proxyId - The proxy that owns this tunnel connection.
   * @returns {void}
   */
  function onMessage(rawData, proxyId, socket = null) {
    let message;
    try {
      message = JSON.parse(rawData.toString());
    } catch {
      return;
    }

    // Keepalive ping from the proxy, answered with a probe the proxy echoes at
    // once: the echo measures the tunnel round trip on this server's own clock,
    // with no timer of its own. A message and not a WebSocket ping frame: on
    // the field path (Cloudflare, nginx) a ping frame's pong never came back.
    if (message.type === "ping") {
      if (socket && socket.readyState === 1 /* OPEN */) {
        socket.send(JSON.stringify({ type: "rtt-probe", sentAt: Date.now() }));
      }
      return;
    }

    // The proxy's echo of that probe.
    if (message.type === "rtt-echo") {
      const sentAt = Number(message.sentAt);
      if (Number.isFinite(sentAt) && sentAt <= Date.now() && connections.get(proxyId) === socket) {
        roundTrips.set(proxyId, Date.now() - sentAt);
      }
      return;
    }

    // What the proxy says about itself, sent when it changes.
    if (message.type === "proxy-state") {
      states.set(proxyId, {
        metrics: message.metrics && typeof message.metrics === "object" ? message.metrics : {},
        holds: Array.isArray(message.holds) ? message.holds : [],
        receivedAt: Date.now()
      });
      return;
    }

    // Endpoint report from proxy (UPnP-mapped external endpoint).
    if (message.type === "proxy-endpoint") {
      if (message.endpoint && onEndpointFromProxy) {
        onEndpointFromProxy(proxyId, message.endpoint);
      }
      return;
    }

    // Answer to "could you sustain this file", asked of every proxy when the
    // one a viewer landed on has refused it.
    if (message.type === "can-serve-response") {
      const pending = pendingCanServeRequests.get(message.requestId);
      if (pending) {
        pendingCanServeRequests.delete(message.requestId);
        pending.resolve({ offer: message.offer ?? null, rttMs: Date.now() - pending.sentAt });
      }
      return;
    }

    // WebRTC signalling: forward proxy → browser via signal hub.
    if (message.type === "signal") {
      if (typeof message.sessionId === "string" && message.signal && onSignalFromProxy) {
        onSignalFromProxy(message.sessionId, message.signal);
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
    registerConnection(proxyId, socket, { followsMoves = false } = {}) {
      const previousSocket = connections.get(proxyId);
      if (previousSocket && previousSocket.readyState < 2 /* CLOSING */) {
        previousSocket.close(1000, "replaced");
      }
      connections.set(proxyId, socket);
      if (followsMoves) {
        followingMoves.add(socket);
      }
      socket.on("message", (data) => onMessage(data, proxyId, socket));
      socket.on("close", () => {
        if (connections.get(proxyId) === socket) {
          connections.delete(proxyId);
          states.delete(proxyId);
          roundTrips.delete(proxyId);
          onConnectionChange?.(proxyId, false);
        }
      });
      onConnectionChange?.(proxyId, true);
      for (const resolve of [...firstConnectionWaiters]) resolve();
    },

    connectedProxies() {
      return connectedProxies();
    },

    waitForFirstConnection({ signal } = {}) {
      if (connectedProxies().length > 0) return Promise.resolve();
      if (signal?.aborted) return Promise.reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
      return new Promise((resolve, reject) => {
        const cleanup = () => {
          firstConnectionWaiters.delete(onConnected);
          signal?.removeEventListener("abort", onAbort);
        };
        const onConnected = () => {
          cleanup();
          resolve();
        };
        const onAbort = () => {
          cleanup();
          reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
        };
        firstConnectionWaiters.add(onConnected);
        signal?.addEventListener("abort", onAbort, { once: true });
        // Close the race between the initial check and registering the waiter.
        if (connectedProxies().length > 0) onConnected();
      });
    },

    askToMove(proxyId) {
      const socket = connections.get(proxyId);
      if (socket && socket.readyState === 1 /* OPEN */) {
        socket.send(JSON.stringify({ type: "server-moving" }));
      }
    },

    closeAll(code, reason) {
      for (const socket of connections.values()) {
        if (socket.readyState < 2 /* CLOSING */) {
          socket.close(code, reason);
        }
      }
    },

    setConnectionHandler(handler) {
      onConnectionChange = handler;
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
     * Wire up the callback that receives `proxy-endpoint` reports.
     * Called once during server bootstrap.
     *
     * @param {(proxyId: string, endpoint: { externalIp: string | null, externalPort: number, protocol: string }) => void} handler
     * @returns {void}
     */
    setEndpointHandler(handler) {
      onEndpointFromProxy = handler;
    },

    /**
     * What a connected proxy last said about itself, and the tunnel round trip
     * last measured to it. `null` while it has said nothing yet — a proxy that
     * has just connected sends its state at once.
     *
     * @param {string} proxyId
     * @returns {ProxyState | null}
     */
    stateOf(proxyId) {
      const state = states.get(proxyId);
      return state ? { ...state, rttMs: roundTrips.get(proxyId) ?? null } : null;
    },

    /**
     * Ask a proxy whether it could sustain a file it is only told ABOUT.
     *
     * The description comes from the proxy that already probed the file, so
     * nobody else adds the torrent, fetches a byte or runs ffmpeg: the answer
     * is arithmetic against that host's own startup benchmarks and comes back
     * in milliseconds. That is what makes it affordable to ask everyone.
     *
     * @param {string} proxyId
     * @param {object} mediaInfo - Height, width, rate, bitrate, codec.
     * @param {number} [timeoutMs]
     * @returns {Promise<{ offer: { copy: number[], transcode: number[] } | null, rttMs: number }>}
     */
    requestCanServe(proxyId, mediaInfo, timeoutMs = 2_000) {
      const socket = connections.get(proxyId);
      if (!socket || socket.readyState !== 1 /* OPEN */) {
        return Promise.reject(new Error("Proxy tunnel is not connected."));
      }

      const requestId = randomUUID();
      const sentAt = Date.now();

      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pendingCanServeRequests.delete(requestId);
          reject(new Error("Capability request timed out."));
        }, timeoutMs);

        pendingCanServeRequests.set(requestId, {
          resolve: (result) => { clearTimeout(timer); resolve(result); },
          reject: (err) => { clearTimeout(timer); reject(err); },
          sentAt
        });

        socket.send(JSON.stringify({ type: "can-serve-request", requestId, mediaInfo }));
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
    }
  };
}
