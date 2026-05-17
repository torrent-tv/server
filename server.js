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
import { handleApiProxyClientsRegisterPost } from "./routes/api/proxy-clients/register/post.js";
import { handleApiProxyClientsGet } from "./routes/api/proxy-clients/get.js";
import { handleApiProxyClientsHealthGet } from "./routes/api/proxy-clients/health/get.js";
import { handleWsProxyTunnel } from "./routes/ws/proxy-tunnel/get.js";
import { handleWsBrowserSignal } from "./routes/ws/browser-signal/get.js";
import { createSignalHub } from "./services/signal-hub.js";
import { handleHealthGet } from "./routes/health/get.js";
import { handleHealthzGet } from "./routes/healthz/get.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicRoot = path.resolve(__dirname, "./public");
const vendorRoot = path.resolve(__dirname, "./node_modules/hls.js/dist");

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

// Wire up signal routing: proxy → tunnelServer → signalHub → browser
tunnelServer.setSignalHandler((sessionId, signal) => {
  signalHub.forwardToBrowser(sessionId, signal);
});

await app.register(fastifyWebsocket);

await app.register(fastifyHelmet, {
  contentSecurityPolicy: {
    useDefaults: false,
    directives: {
      defaultSrc: ["'self'"],
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
  handleWsProxyTunnel(socket, req, { tunnelServer, serverToken })
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

app.get("/health", async (req, reply) => handleHealthGet(req, reply, { shutdownState }));
app.get("/healthz", async (req, reply) => handleHealthzGet(req, reply, { shutdownState }));

await app.register(fastifyStatic, {
  root: publicRoot,
  prefix: "/",
  serveDotFiles: true
});
await app.register(fastifyStatic, {
  root: vendorRoot,
  prefix: "/vendor/",
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
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
