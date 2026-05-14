import { nowIso } from "../utils/time.js";

/**
 * @typedef {Object} ProxyClientRecord
 * @property {string} id          - Stable unique identifier for the proxy client.
 * @property {string} name        - Human-readable display name.
 * @property {string} baseUrl     - Reachable base URL of the proxy HTTP server.
 * @property {string} createdAt   - ISO timestamp of first registration.
 * @property {string} lastSeenAt  - ISO timestamp of last registration or heartbeat.
 */

/**
 * Create an in-memory store for registered proxy clients.
 *
 * @returns {{
 *   upsertClient: (params: { id: string, name: string, baseUrl: string }) => ProxyClientRecord,
 *   touchClient:  (id: string) => ProxyClientRecord | null,
 *   listClients:  () => ProxyClientRecord[]
 * }}
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
     * Update `lastSeenAt` for an existing client (heartbeat).
     * Returns `null` if no client with the given ID exists.
     *
     * @param {string} id
     * @returns {ProxyClientRecord | null}
     */
    touchClient(id) {
      const client = clients.get(id);
      if (!client) {
        return null;
      }
      client.lastSeenAt = nowIso();
      return client;
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
