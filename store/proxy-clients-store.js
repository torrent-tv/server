import { nowIso } from "../utils/time.js";

/**
 * The externally-reachable endpoint a proxy opened via UPnP/NAT-PMP and
 * reported over the tunnel. Verified by the server's dial-back probe.
 *
 * @typedef {Object} ProxyEndpoint
 * @property {string | null} externalIp   - Public IP as seen by the proxy's router, or null if unknown.
 * @property {number}        externalPort - Mapped external port.
 * @property {"TCP" | "UDP"} protocol      - Mapped protocol.
 */

/**
 * @typedef {Object} ProxyClientRecord
 * @property {string}  id         - Stable unique identifier for the proxy client.
 * @property {string}  name       - Human-readable display name.
 * @property {string}  baseUrl    - Base URL advertised by the proxy (used for display only).
 * @property {string}  createdAt  - ISO timestamp of first registration.
 * @property {string}  lastSeenAt - ISO timestamp of last registration.
 * @property {ProxyEndpoint | null} endpoint - Last endpoint reported by the proxy, or null.
 * @property {boolean | null} reachable - Result of the last dial-back probe (null = not probed yet).
 * @property {string | null} lastProbedAt - ISO timestamp of the last dial-back probe, or null.
 */

/**
 * Public API of the proxy client store.
 *
 * @typedef {Object} ProxyClientsStore
 * @property {(params: { id: string, name: string, baseUrl: string }) => ProxyClientRecord} upsertClient
 *   Insert or update a proxy client record.
 * @property {(id: string, params: { endpoint: ProxyEndpoint | null, reachable: boolean | null, lastProbedAt: string | null }) => ProxyClientRecord} setReachability
 *   Record the reported endpoint and dial-back result. Creates a minimal record
 *   if the proxy reported its endpoint before the HTTP registration landed.
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
        lastSeenAt: nowIso(),
        // Preserve reachability across re-registrations — the proxy re-registers
        // on every tunnel reconnect, and a fresh record here would wipe a
        // previously-probed endpoint.
        endpoint: existing?.endpoint ?? null,
        reachable: existing?.reachable ?? null,
        lastProbedAt: existing?.lastProbedAt ?? null
      };
      clients.set(trimmedId, record);
      return record;
    },

    /**
     * Record the reported endpoint and dial-back result for a proxy.
     * Creates a minimal record if the endpoint report arrives before the HTTP
     * registration (the two race on tunnel connect); a later `upsertClient`
     * fills in name/baseUrl and preserves these fields.
     *
     * @param {string} id
     * @param {{ endpoint: ProxyEndpoint | null, reachable: boolean | null, lastProbedAt: string | null }} params
     * @returns {ProxyClientRecord}
     */
    setReachability(id, { endpoint, reachable, lastProbedAt }) {
      const trimmedId = id.trim();
      const existing = clients.get(trimmedId);
      const record = {
        id: trimmedId,
        name: existing?.name ?? trimmedId,
        baseUrl: existing?.baseUrl ?? "",
        createdAt: existing?.createdAt ?? nowIso(),
        lastSeenAt: existing?.lastSeenAt ?? nowIso(),
        endpoint,
        reachable,
        lastProbedAt
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
