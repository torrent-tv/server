import { nowIso } from "../utils/time.js";

/**
 * @typedef {Object} ProxyClientRecord
 * @property {string}  id         - Stable unique identifier for the proxy client.
 * @property {string}  name       - Human-readable display name.
 * @property {string}  baseUrl    - Base URL advertised by the proxy (used for display only).
 * @property {string}  createdAt  - ISO timestamp of first registration.
 * @property {string}  lastSeenAt - ISO timestamp of last registration.
 */

/**
 * Public API of the proxy client store.
 *
 * @typedef {Object} ProxyClientsStore
 * @property {(params: { id: string, name: string, baseUrl: string }) => ProxyClientRecord} upsertClient
 *   Insert or update a proxy client record.
 * @property {() => ProxyClientRecord[]} listClients
 *   Return all registered proxy clients.
 */

/**
 * Create an in-memory store for registered proxy clients.
 *
 * Liveness is determined by whether the proxy has an active WebSocket tunnel
 * connection — not by any field stored here.  Use `tunnelServer.isConnected(id)`
 * at query time instead of caching a boolean in the record.
 *
 * @returns {ProxyClientsStore}
 */
export function createProxyClientsStore() {
  /** @type {Map<string, ProxyClientRecord>} */
  const clients = new Map();

  return {
    /**
     * Insert or update a proxy client record.
     * `createdAt` is preserved for existing clients; `lastSeenAt` is always refreshed.
     *
     * @param {{ id: string, name: string, baseUrl: string }} params
     * @returns {ProxyClientRecord}
     */
    upsertClient({ id, name, baseUrl }) {
      const trimmedId = id.trim();
      const normalizedBaseUrl = baseUrl.trim().replace(/\/+$/, "");
      const existing = clients.get(trimmedId);
      const record = {
        id: trimmedId,
        name: name.trim().length > 0 ? name.trim() : trimmedId,
        baseUrl: normalizedBaseUrl,
        createdAt: existing?.createdAt ?? nowIso(),
        lastSeenAt: nowIso()
      };
      clients.set(trimmedId, record);
      return record;
    },

    /**
     * Return all registered proxy clients.
     *
     * @returns {ProxyClientRecord[]}
     */
    listClients() {
      return Array.from(clients.values());
    }
  };
}
