/**
 * Which proxy this viewer should connect to (torrent-tv/meta#36).
 *
 * POST /api/proxy-clients/choose
 * body: { infoHash?: string, tried?: { id: string, error: string }[], onlyIds?: string[], current?: string }
 *
 * Answered from the table every proxy keeps current over its tunnel, so nothing
 * is asked of a proxy and nothing is waited for. The page names the film it is
 * about to open by its infohash and is told ONE proxy; which films any proxy
 * holds stays on this server. When the page cannot connect to the proxy it was
 * given, it asks again with that proxy and the error in `tried` and is given
 * the next. `tried` applies to that request only: one page reporting failures
 * does not take a proxy out of the pool for anybody else.
 *
 * Answers `{ chosen, candidates }`: `chosen` is the proxy (`null` when no proxy
 * is left), `candidates` the pool it was chosen from, for the page's own debug
 * view — each with whether it holds THIS film, never the list of what it holds.
 */

import { chooseProxy, scoreProxy } from "../../../../services/proxy-choice.js";
import { proxyCandidates, requesterPublicIp } from "../../../../services/proxy-candidates.js";

const INFO_HASH = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/iu;

/** Most proxies a page may name as tried or allowed in one request. */
const MAX_IDS = 64;

/**
 * @param {import("fastify").FastifyRequest} req
 * @param {import("fastify").FastifyReply} reply
 * @param {{ clientsStore: import("../../../../store/proxy-clients-store.js").ProxyClientsStore, tunnelServer: import("../../../../services/proxy-tunnel-server.js").ProxyTunnelServer }} deps
 * @returns {Promise<void>}
 */
export async function handleApiProxyClientsChoosePost(req, reply, { clientsStore, tunnelServer }) {
  const body = req.body ?? {};
  const infoHash = typeof body.infoHash === "string" ? body.infoHash.trim() : "";
  if (infoHash !== "" && !INFO_HASH.test(infoHash)) {
    return reply.code(400).send({ error: "infoHash must be 40 or 64 hex digits." });
  }
  const tried = Array.isArray(body.tried) ? body.tried : [];
  const onlyIds = Array.isArray(body.onlyIds) ? body.onlyIds : null;
  if (tried.length > MAX_IDS || (onlyIds?.length ?? 0) > MAX_IDS ||
      !tried.every((one) => typeof one?.id === "string" && one.id.length <= 200 && typeof (one.error ?? "") === "string") ||
      !(onlyIds ?? []).every((id) => typeof id === "string" && id.length <= 200) ||
      (body.current != null && typeof body.current !== "string")) {
    return reply.code(400).send({ error: `tried must be { id, error } and onlyIds ids, at most ${MAX_IDS} each.` });
  }
  for (const { id, error } of tried) {
    // Which proxy a viewer could not reach, and why: the only record of a
    // proxy that is connected to this server and unusable from outside.
    console.log(`[proxy-choice] a viewer could not connect to proxy ${id.slice(0, 8)}: ${String(error ?? "").slice(0, 300)}`);
  }
  const candidates = proxyCandidates({ clientsStore, tunnelServer, requesterIp: requesterPublicIp(req), infoHash });
  const { chosen, pool, narrowedBy } = chooseProxy(candidates, {
    tried: tried.map((one) => one.id),
    onlyIds,
    current: typeof body.current === "string" ? body.current : null
  });
  return reply.send({
    chosen,
    narrowedBy,
    candidates: pool.map((one) => ({ ...one, score: Number(scoreProxy(one).toFixed(4)) }))
  });
}
