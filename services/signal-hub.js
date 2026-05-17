/**
 * @file Browser-side WebRTC signalling hub.
 *
 * Each browser that wants to establish a WebRTC connection to a proxy
 * opens a WebSocket to /ws/browser-signal and receives a sessionId.
 * The hub routes signals between that WebSocket and the proxy tunnel.
 */

import { randomUUID } from "node:crypto";

/**
 * @typedef {Object} SignalHub
 * @property {(socket: import("ws").WebSocket, onSignal: (sessionId: string, proxyId: string, signal: object) => void) => string} registerBrowser
 * @property {(sessionId: string, signal: object) => void} forwardToBrowser
 */

/**
 * Create the signal hub that manages browser WebSocket connections.
 *
 * @returns {SignalHub}
 */
export function createSignalHub() {
  /** @type {Map<string, import("ws").WebSocket>} sessionId → browser socket */
  const sessions = new Map();

  return {
    /**
     * Register a new browser WebSocket for signalling.
     * Returns the session ID assigned to this connection.
     *
     * @param {import("ws").WebSocket} socket
     * @param {(sessionId: string, proxyId: string, signal: object) => void} onSignal
     *   Called when the browser sends a signal that should be forwarded to a proxy.
     * @returns {string} sessionId
     */
    registerBrowser(socket, onSignal) {
      const sessionId = randomUUID();
      sessions.set(sessionId, socket);

      // Send the session ID to the browser immediately so it can include it in signals.
      socket.send(JSON.stringify({ type: "session", sessionId }));

      socket.on("message", (rawData) => {
        let message;
        try {
          message = JSON.parse(rawData.toString());
        } catch {
          return;
        }
        const proxyId = typeof message.proxyId === "string" ? message.proxyId : "";
        if (!proxyId) {
          return;
        }
        // Forward offer / candidate from browser to proxy.
        if (message.type === "offer" || message.type === "candidate") {
          onSignal(sessionId, proxyId, message);
        }
      });

      socket.on("close", () => {
        sessions.delete(sessionId);
      });

      return sessionId;
    },

    /**
     * Forward a signal from the proxy to the waiting browser session.
     *
     * @param {string} sessionId
     * @param {object} signal
     * @returns {void}
     */
    forwardToBrowser(sessionId, signal) {
      const socket = sessions.get(sessionId);
      if (socket && socket.readyState === 1 /* OPEN */) {
        socket.send(JSON.stringify(signal));
      }
    }
  };
}
