import { createRequire } from "node:module";
import Fastify from "fastify";
import fastifyCors from "@fastify/cors";
import fastifyHelmet from "@fastify/helmet";
import fastifyStatic from "@fastify/static";
import fastifyWebsocket from "@fastify/websocket";
import getPort from "get-port";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createProxyClientsStore } from "./store/proxy-clients-store.js";
import { createProxyTunnelServer } from "./services/proxy-tunnel-server.js";
import { createReachabilityProber } from "./services/reachability-prober.js";
import { handleApiProxyClientsRegisterPost } from "./routes/api/proxy-clients/register/post.js";
import { handleApiProxyClientsGet } from "./routes/api/proxy-clients/get.js";
import { handleApiProxyClientsHealthGet } from "./routes/api/proxy-clients/health/get.js";
import { handleApiProxyClientsCanServePost } from "./routes/api/proxy-clients/can-serve/post.js";
import { handleApiClientLogsPost } from "./routes/api/client-logs/post.js";
import { handleWsProxyTunnel } from "./routes/ws/proxy-tunnel/get.js";
import { handleWsBrowserSignal } from "./routes/ws/browser-signal/get.js";
import { createSignalHub } from "./services/signal-hub.js";
import { createInstanceRole } from "./services/instance-role.js";
import { publishRelease } from "./services/static-release.js";
import { CONNECT_TIMEOUT_MS } from "./public/domain/connect-deadline.js";
import { ExclusiveCache } from "./services/cache/ExclusiveCache.js";
import { handleHealthGet } from "./routes/health/get.js";
import { handleHealthzGet } from "./routes/healthz/get.js";
import { handleEnvGet } from "./routes/env/get.js";
import { createMetadata } from "./services/metadata/create-metadata.js";
import { DiskCache } from "./services/cache/DiskCache.js";
import { MetadataCache } from "./services/metadata/MetadataCache.js";
import { createSubtitles } from "./services/subtitles/create-subtitles.js";
import { handleApiSubtitlesSearchPost } from "./routes/api/subtitles/search/post.js";
import { handleApiSubtitlesFilePost } from "./routes/api/subtitles/file/post.js";
import {
  IDENTIFY_BODY_LIMIT,
  handleApiMetadataIdentifyPost
} from "./routes/api/metadata/identify/post.js";
import { CONTAINER_BODY_LIMIT, handleApiMetadataContainerPost } from "./routes/api/metadata/container/post.js";
import {
  EPISODES_BODY_LIMIT,
  handleApiMetadataEpisodesPost
} from "./routes/api/metadata/episodes/post.js";
import { handleApiMetadataImageGet } from "./routes/api/metadata/image/get.js";
import { handleApiMetadataCoverGet } from "./routes/api/metadata/cover/get.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const require = createRequire(import.meta.url);
const { version } = require("./package.json");
const publicRoot = path.resolve(__dirname, "./public");
const vendorRoot = path.resolve(__dirname, "./node_modules/hls.js/dist");
const mediaChromeRoot = path.resolve(__dirname, "./node_modules/media-chrome/dist");

const preferredPort = Number(process.env.PORT ?? 8080);
const serverToken = process.env.PROXY_TOKEN ?? "";

const app = Fastify({
  bodyLimit: 10 * 1024 * 1024
});
const shutdownTimeoutMs = 10_000;
const shutdownState = {
  isShuttingDown: false
};

const clientsStore = createProxyClientsStore();
const tunnelServer = createProxyTunnelServer();
const signalHub = createSignalHub();
const cacheMiB = Number(process.env.SERVER_CACHE_MIB ?? 1024);
if (!Number.isSafeInteger(cacheMiB) || cacheMiB < 16 || cacheMiB > 16384) throw new Error("SERVER_CACHE_MIB must be an integer from 16 to 16384");
const reserveMiB = Number(process.env.SERVER_CACHE_RESERVE_MIB ?? 256);
if (!Number.isSafeInteger(reserveMiB) || reserveMiB < 0 || reserveMiB > 16384) throw new Error("SERVER_CACHE_RESERVE_MIB must be an integer from 0 to 16384");
// Opened only while this instance serves: the other slot shares the directory.
const diskCache = process.env.SERVER_CACHE_DIR
  ? new ExclusiveCache(() => new DiskCache({ directory: process.env.SERVER_CACHE_DIR, budgetBytes: cacheMiB * 1024 ** 2, reserveBytes: reserveMiB * 1024 ** 2 }))
  : null;
const subtitleCache = diskCache?.namespace("subtitles") ?? new MetadataCache({ budgetBytes: 8 * 1024 ** 2, maxEntryBytes: 4 * 1024 ** 2 });
const subtitles = createSubtitles(subtitleCache);
const { service: metadata, images: metadataImages, covers: adultCovers, containers: containerRecords } = createMetadata({
  token: process.env.TMDB_READ_TOKEN?.trim() || null,
  theporndbKey: process.env.THEPORNDB_API_KEY?.trim() || null,
  stashdbKey: process.env.STASHDB_API_KEY?.trim() || null,
  cache: diskCache?.namespace("tmdb"),
  animeCache: diskCache?.namespace("anilist"),
  containerCache: diskCache?.namespace("container")
});
app.addHook("onClose", async () => { await diskCache?.stop(); });

// Which of the two slots serves, and the handover between them at a release
// (services/instance-role.js). Without SERVER_PEER this instance serves alone.
const slot = process.env.SERVER_SLOT ?? "solo";
const role = createInstanceRole({
  slot,
  version,
  peerUrl: process.env.SERVER_PEER ? `ws://${process.env.SERVER_PEER}/internal/hand-over` : null,
  tunnelServer,
  signalHub,
  connectDeadlineMs: CONNECT_TIMEOUT_MS,
  async onServe() {
    await diskCache?.start();
    if (process.env.STATIC_VOLUME_DIR && process.env.STATIC_RELEASE) {
      try {
        await publishRelease({ volumeDir: process.env.STATIC_VOLUME_DIR, release: process.env.STATIC_RELEASE });
      } catch (error) {
        console.error(`[static] could not publish release ${process.env.STATIC_RELEASE}: ${error?.message ?? error}`);
      }
    }
  },
  async onLeave() {
    await diskCache?.stop();
  }
});
tunnelServer.setConnectionHandler((proxyId, connected) => {
  role.onProxyConnection(proxyId, connected);
});

// Wire up signal routing: proxy → tunnelServer → signalHub → browser
tunnelServer.setSignalHandler((sessionId, signal) => {
  signalHub.forwardToBrowser(sessionId, signal);
});

// Dial-back reachability probe: when a proxy reports its UPnP-mapped endpoint,
// connect to it from the droplet to verify it is reachable from the internet.
const reachabilityProber = createReachabilityProber({ clientsStore, tunnelServer });
tunnelServer.setEndpointHandler((proxyId, endpoint) => {
  void reachabilityProber.probe(proxyId, endpoint);
});
reachabilityProber.start();
app.addHook("onClose", async () => {
  reachabilityProber.stop();
});

await app.register(fastifyWebsocket);

// An instance that does not serve answers 503, and nginx sends the request to
// the other slot. Health and the handover itself are always answered; proxy
// tunnels are accepted by the instance taking over before it serves pages.
app.addHook("onRequest", (req, reply, done) => {
  const path = req.url.split("?", 1)[0];
  if (path === "/health" || path === "/healthz") {
    done();
    return;
  }
  // The handover is for the peer slot alone, which connects directly. nginx
  // marks everything it forwards with the client's address, and an instance
  // without a peer expects no handover at all.
  if (path.startsWith("/internal/")) {
    if (process.env.SERVER_PEER && !req.headers["x-forwarded-for"] && !req.headers["x-real-ip"]) {
      done();
      return;
    }
    reply.code(404).send({ error: "Not found." });
    return;
  }
  const accepted = path === "/ws/proxy-tunnel" ? role.acceptsTunnels() : role.acceptsPages();
  if (accepted) {
    done();
    return;
  }
  reply.code(503).send({ error: "This server instance is not serving.", instance: role.describe() });
});

app.get("/internal/hand-over", { websocket: true }, (socket) => role.acceptPeer(socket));

await app.register(fastifyHelmet, {
  contentSecurityPolicy: {
    useDefaults: false,
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "https://cdn.jsdelivr.net", "'unsafe-inline'", "'unsafe-eval'"],
      // `blob:` for the cover a video file carries inside it, which the page
      // receives from its proxy and shows from memory (meta#139).
      imgSrc: ["'self'", "data:", "blob:", "https://cdn.jsdelivr.net"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      fontSrc: ["'self'", "data:"],
      workerSrc: ["'self'", "blob:"],
      connectSrc: ["'self'", "http:", "https:"],
      mediaSrc: ["'self'", "http:", "https:", "blob:"]
    }
  }
});
await app.register(fastifyCors, {
  origin: true,
  methods: ["GET", "POST", "OPTIONS"]
});

app.get("/ws/proxy-tunnel", { websocket: true }, (socket, req) =>
  handleWsProxyTunnel(socket, req, { tunnelServer, clientsStore, serverToken })
);

app.get("/ws/browser-signal", { websocket: true }, (socket, req) =>
  handleWsBrowserSignal(socket, req, { signalHub, tunnelServer })
);

app.post("/api/proxy-clients/register", async (req, reply) =>
  handleApiProxyClientsRegisterPost(req, reply, { clientsStore, serverToken })
);
app.get("/api/proxy-clients", async (req, reply) =>
  handleApiProxyClientsGet(req, reply, { clientsStore, tunnelServer })
);
app.get("/api/proxy-clients/health", async (req, reply) =>
  handleApiProxyClientsHealthGet(req, reply, { clientsStore, tunnelServer })
);
// Which proxies could sustain a file the browser already has a description of.
// Asked only after one has refused it, so the viewer is sent somewhere that
// works instead of being shown an error on the one they happened to land on.
app.post("/api/proxy-clients/can-serve", async (req, reply) =>
  handleApiProxyClientsCanServePost(req, reply, { clientsStore, tunnelServer })
);

// Browser console-log forwarder (debugging aid; writes client logs to the
// server container log so iPhone/eruda logs need not be copy-pasted).
app.post("/api/client-logs", async (req, reply) => handleApiClientLogsPost(req, reply));

// What a release is — poster, title, episode names — from TMDB, through this
// server so that the browser never talks to a third party and the token stays
// here. Never on the playback path: every answer may be late, absent or refused.
app.post("/api/metadata/identify", { bodyLimit: IDENTIFY_BODY_LIMIT }, async (req, reply) =>
  handleApiMetadataIdentifyPost(req, reply, { metadata, containerRecords })
);
app.post("/api/metadata/container", { bodyLimit: CONTAINER_BODY_LIMIT }, async (req, reply) =>
  handleApiMetadataContainerPost(req, reply, { containerRecords })
);
app.post("/api/metadata/episodes", { bodyLimit: EPISODES_BODY_LIMIT }, async (req, reply) =>
  handleApiMetadataEpisodesPost(req, reply, { metadata })
);
app.get("/api/metadata/image/:size/:file", async (req, reply) =>
  handleApiMetadataImageGet(req, reply, { images: metadataImages })
);
app.get("/api/metadata/cover/:source/:id", async (req, reply) =>
  handleApiMetadataCoverGet(req, reply, { covers: adultCovers })
);
app.post("/api/subtitles/search", { bodyLimit: 4096 }, async (req, reply) => handleApiSubtitlesSearchPost(req, reply, { subtitles }));
app.post("/api/subtitles/file", { bodyLimit: 8192 }, async (req, reply) => handleApiSubtitlesFilePost(req, reply, { subtitles }));

app.get("/health", async (req, reply) =>
  handleHealthGet(req, reply, { shutdownState, version, role, diskDirectory: diskCache ? process.env.SERVER_CACHE_DIR : null, diskReserveBytes: reserveMiB * 1024 ** 2 })
);
app.get("/healthz", async (req, reply) => handleHealthzGet(req, reply, { shutdownState, version, role }));

app.get("/about", (_req, reply) => reply.sendFile("about.html"));

app.get("/env.js", async (req, reply) => handleEnvGet(req, reply, { version }));

await app.register(fastifyStatic, {
  root: publicRoot,
  prefix: "/",
  serveDotFiles: true,
  // Force browsers to revalidate cached assets on every request via
  // ETag/If-None-Match (ETag is enabled by @fastify/static by default).
  // Without this, ES modules were cached for hours, making deploys invisible
  // on returning devices. Unchanged files still return a cheap 304.
  cacheControl: false,
  // @fastify/static v10 changed the setHeaders callback to receive the Fastify
  // reply (was the raw ServerResponse in v9), so use reply.header(), not
  // res.setHeader().
  setHeaders: (reply) => {
    reply.header("Cache-Control", "no-cache, must-revalidate");
  }
});
await app.register(fastifyStatic, {
  root: vendorRoot,
  prefix: "/vendor/",
  decorateReply: false
});
await app.register(fastifyStatic, {
  root: mediaChromeRoot,
  prefix: "/vendor/media-chrome/",
  decorateReply: false
});

async function shutdown(signal) {
  if (shutdownState.isShuttingDown) {
    return;
  }
  shutdownState.isShuttingDown = true;
  console.log(`[server] Received ${signal}, shutting down...`);

  const forceTimer = setTimeout(() => {
    console.error("[server] Graceful shutdown timeout exceeded, forcing exit.");
    process.exit(1);
  }, shutdownTimeoutMs);
  forceTimer.unref();

  try {
    await app.close();
    clearTimeout(forceTimer);
    console.log("[server] Graceful shutdown complete.");
    process.exit(0);
  } catch (error) {
    clearTimeout(forceTimer);
    app.log.error(error);
    process.exit(1);
  }
}

process.on("SIGINT", () => {
  void shutdown("SIGINT");
});

process.on("SIGTERM", () => {
  void shutdown("SIGTERM");
});

function buildPortCandidates(startPort, maxAttempts = 51) {
  const ports = [];
  for (let index = 0; index < maxAttempts; index += 1) {
    ports.push(startPort + index);
  }
  return ports;
}

try {
  const port = await getPort({
    port: buildPortCandidates(preferredPort)
  });
  await app.listen({ port, host: "0.0.0.0" });
  console.log(`[server] Listening on http://localhost:${port}`);
  console.log(`[server] Token validation: ${serverToken ? "enabled" : "disabled (PROXY_TOKEN not set)"}`);
  // After listening, so a peer that starts at the same moment always reaches
  // whichever of the two listened first.
  await role.start();
} catch (error) {
  console.error(error);
  process.exit(1);
}
