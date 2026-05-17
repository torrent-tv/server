import { isTokenValid } from "../../../../utils/token.js";

/**
 * Extract a plain object from the request body, guarding against
 * non-object payloads (arrays, primitives, null).
 *
 * @param {unknown} body
 * @returns {Record<string, unknown>}
 */
function getPayload(body) {
  if (body && typeof body === "object" && !Array.isArray(body)) {
    return body;
  }
  return {};
}

/**
 * Normalise the remote IP address from Fastify's `req.ip`.
 * Strips the IPv4-mapped IPv6 prefix `::ffff:` when present.
 *
 * @param {unknown} ip
 * @returns {string}
 */
function normalizeRemoteIp(ip) {
  if (typeof ip !== "string") {
    return "";
  }
  const trimmed = ip.trim();
  if (!trimmed) {
    return "";
  }
  if (trimmed.startsWith("::ffff:")) {
    return trimmed.slice("::ffff:".length);
  }
  return trimmed;
}

/**
 * Return true for hostnames that are local bind-all or loopback addresses
 * and should be replaced with the caller's actual remote IP.
 *
 * @param {string} hostname
 * @returns {boolean}
 */
function shouldReplaceHostname(hostname) {
  const normalized = hostname.trim().toLowerCase();
  return (
    normalized === "0.0.0.0" ||
    normalized === "127.0.0.1" ||
    normalized === "localhost" ||
    normalized === "::" ||
    normalized === "::1" ||
    normalized === "[::]"
  );
}

/**
 * Build the URL at which the proxy is actually reachable.
 * If the proxy advertised a bind-all or loopback hostname (e.g. `0.0.0.0`),
 * replace it with the IP address from which the registration request arrived.
 *
 * @param {string} baseUrl   - URL sent by the proxy in the registration body.
 * @param {string} remoteIp  - IP address of the incoming HTTP connection.
 * @returns {string}
 */
function buildReachableBaseUrl(baseUrl, remoteIp) {
  let parsed;
  try {
    parsed = new URL(baseUrl);
  } catch {
    return baseUrl.trim();
  }

  if (!remoteIp || !shouldReplaceHostname(parsed.hostname)) {
    return parsed.toString().replace(/\/+$/, "");
  }

  const rewritten = new URL(parsed.toString());
  rewritten.hostname = remoteIp;
  return rewritten.toString().replace(/\/+$/, "");
}

/**
 * Produce a public-facing summary of a proxy client record.
 *
 * @param {import("../../../../store/proxy-clients-store.js").ProxyClientRecord} client
 * @returns {{ id: string, name: string, baseUrl: string, createdAt: string, lastSeenAt: string }}
 */
function toClientSummary(client) {
  return {
    id: client.id,
    name: client.name,
    baseUrl: client.baseUrl,
    createdAt: client.createdAt,
    lastSeenAt: client.lastSeenAt
  };
}

/**
 * Register a proxy client with the server.
 * If a client with the same ID already exists it is updated in place.
 *
 * The proxy's liveness is tracked via its WebSocket tunnel connection —
 * no HTTP health probe is performed here.
 *
 * POST /api/proxy-clients/register
 *
 * @param {import("fastify").FastifyRequest} req
 * @param {import("fastify").FastifyReply} reply
 * @param {{ clientsStore: import("../../../../store/proxy-clients-store.js").ProxyClientsStore, serverToken: string }} deps
 * @returns {Promise<void>}
 */
export async function handleApiProxyClientsRegisterPost(req, reply, { clientsStore, serverToken }) {
  const clientToken = typeof req.headers["x-proxy-token"] === "string"
    ? req.headers["x-proxy-token"]
    : "";

  if (!isTokenValid(serverToken, clientToken)) {
    return reply.code(401).send({ error: "Unauthorized." });
  }

  const payload = getPayload(req.body);
  const { id, name, baseUrl } = payload;

  if (typeof id !== "string" || id.trim().length === 0) {
    return reply.code(400).send({ error: "Client id is required." });
  }
  if (typeof baseUrl !== "string" || baseUrl.trim().length === 0) {
    return reply.code(400).send({ error: "Client baseUrl is required." });
  }

  const safeName = typeof name === "string" ? name : "";
  const remoteIp = normalizeRemoteIp(req.ip);
  const reachableBaseUrl = buildReachableBaseUrl(baseUrl, remoteIp);
  const record = clientsStore.upsertClient({
    id,
    name: safeName,
    baseUrl: reachableBaseUrl
  });

  return reply.send({ client: toClientSummary(record) });
}
