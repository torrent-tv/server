/**
 * Which proxies could sustain a file they are only told ABOUT.
 *
 * Asked when the proxy a viewer landed on has refused their file — it measured
 * itself against this source and found no height it can hold, not even copying
 * the picture, which costs it no encoder at all. Starting anyway would give the
 * viewer a slideshow and take the swarm and the processor from whoever is
 * already watching there.
 *
 * **Why this is cheap.** The expensive half of the question is finding out what
 * the file IS — the torrent has to be added, its metadata awaited, its header
 * pieces fetched and ffmpeg run over them. That has already happened once, on
 * the proxy that refused. Its answer is a handful of numbers, and those travel
 * here: every other proxy answers by arithmetic against its own startup
 * benchmarks, without adding the torrent, fetching a byte or running ffmpeg. So
 * the whole pool can be asked in the time one round trip takes.
 *
 * The viewer is picked a proxy before the file is known — the scoring reads
 * processor load, free memory and round-trip time, none of which can answer a
 * question about a particular source. This route is where that ordering is
 * repaired, after the fact and only when it went wrong.
 *
 * POST /api/proxy-clients/can-serve
 * body: { mediaInfo: { width, height, fps, bitrateKbps, ... }, exclude?: string }
 */

/**
 * @param {import("fastify").FastifyRequest} req
 * @param {import("fastify").FastifyReply} reply
 * @param {{ clientsStore: import("../../../../store/proxy-clients-store.js").ProxyClientsStore, tunnelServer: import("../../../../services/proxy-tunnel-server.js").ProxyTunnelServer }} deps
 * @returns {Promise<void>}
 */
export async function handleApiProxyClientsCanServePost(req, reply, { clientsStore, tunnelServer }) {
  const mediaInfo = req.body?.mediaInfo;
  if (!mediaInfo || typeof mediaInfo !== "object") {
    return reply.code(400).send({ error: "mediaInfo is required." });
  }
  // The one that refused. Asking it again would cost a round trip to be told
  // what we already know.
  const exclude = typeof req.body?.exclude === "string" ? req.body.exclude : "";

  const connected = clientsStore
    .listClients()
    .filter((client) => client.id !== exclude && tunnelServer.isConnected(client.id));

  const clients = await Promise.all(
    connected.map(async (client) => {
      try {
        const { offer, rttMs } = await tunnelServer.requestCanServe(client.id, mediaInfo);
        const heights = [...(offer?.copy ?? []), ...(offer?.transcode ?? [])];
        return {
          id: client.id,
          name: client.name,
          // Both lists empty is the same answer the refusing proxy gave about
          // itself: no height works here either.
          canServe: heights.length > 0,
          offer: offer ?? null,
          rttMs
        };
      } catch {
        // A proxy that did not answer in time is not a proxy to send a viewer
        // to. Reported rather than dropped, so the browser can say how many
        // were asked.
        return { id: client.id, name: client.name, canServe: false, offer: null, rttMs: null };
      }
    })
  );

  return reply.send({
    asked: clients.length,
    clients: clients.filter((client) => client.canServe)
  });
}
