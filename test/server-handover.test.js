/**
 * @file Two real server processes hand over a proxy at a release.
 *
 * The slot that serves holds a proxy's tunnel. A new version starts in the
 * other slot, the proxy is asked to move and reaches the new process — here
 * directly, where nginx would send it after the old one refused it — and the
 * new process lists it by the name the connection carried, without the
 * separate registration request. The old one then refuses pages and tunnels,
 * which is what makes nginx send them to the new one.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import getPort from "get-port";
import { WebSocket } from "ws";

const serverEntry = fileURLToPath(new URL("../server.js", import.meta.url));

async function waitFor(until, what, limit = 20_000) {
  const deadline = Date.now() + limit;
  while (!(await until())) {
    if (Date.now() > deadline) {
      throw new Error(`${what} never happened`);
    }
    await new Promise((resolve) => { setTimeout(resolve, 20); });
  }
}

/**
 * Start `server.js` as one slot. A copy of package.json with another version
 * is not possible without copying the server, so the "new version" is the
 * same version in the other slot, which takes over by the same rule.
 */
function startSlot({ port, slot, peerPort }) {
  const child = spawn(process.execPath, [serverEntry], {
    env: {
      ...process.env,
      PORT: String(port),
      SERVER_SLOT: slot,
      ...(peerPort ? { SERVER_PEER: `127.0.0.1:${peerPort}` } : {}),
      SERVER_CACHE_DIR: "",
      TMDB_READ_TOKEN_FILE: ""
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  const output = [];
  child.stdout.on("data", (data) => output.push(String(data)));
  child.stderr.on("data", (data) => output.push(String(data)));
  return { child, output };
}

async function instanceOf(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/healthz`);
    return (await response.json()).instance;
  } catch {
    return null;
  }
}

/** A proxy that follows moves, answering health on the connection asked. */
function fakeProxy(firstPort, moveToPort) {
  const sockets = [];
  const open = (port) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws/proxy-tunnel`, {
      headers: {
        "x-proxy-id": "proxy-1",
        "x-proxy-name": encodeURIComponent("Гостиная"),
        "x-proxy-base-url": "http://192.168.1.7:9090",
        "x-proxy-follows-moves": "1"
      }
    });
    socket.on("message", (data) => {
      const message = JSON.parse(String(data));
      if (message.type === "health-request") {
        socket.send(JSON.stringify({ type: "health-response", requestId: message.requestId, metrics: {}, holds: [] }));
      }
      if (message.type === "server-moving") {
        open(moveToPort);
      }
    });
    sockets.push(socket);
  };
  open(firstPort);
  return { close: () => { for (const socket of sockets) socket.terminate(); } };
}

/** What a tunnel upgrade to this port is answered with. */
function tunnelUpgradeStatus(port) {
  return new Promise((resolve) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws/proxy-tunnel`, { headers: { "x-proxy-id": "probe" } });
    socket.on("open", () => { socket.terminate(); resolve(101); });
    socket.on("unexpected-response", (_req, res) => { resolve(res.statusCode); socket.terminate(); });
    socket.on("error", () => {});
  });
}

test("a new slot takes the proxy over and the old one refuses what it no longer serves", async (t) => {
  const portA = await getPort();
  const portB = await getPort({ exclude: [portA] });
  const a = startSlot({ port: portA, slot: "a", peerPort: portB });
  let b = null;
  let proxy = null;
  t.after(() => {
    proxy?.close();
    a.child.kill();
    b?.child.kill();
  });

  await waitFor(async () => (await instanceOf(portA))?.state === "serving", "slot a serving");
  proxy = fakeProxy(portA, portB);
  await waitFor(async () => {
    const response = await fetch(`http://127.0.0.1:${portA}/api/proxy-clients/health`);
    return response.ok && JSON.stringify(await response.json()).includes("proxy-1");
  }, "the proxy listed on slot a");

  b = startSlot({ port: portB, slot: "b", peerPort: portA });
  await waitFor(async () => (await instanceOf(portB))?.state === "serving", `slot b serving\n${b.output.join("")}\n${a.output.join("")}`);

  const listed = await (await fetch(`http://127.0.0.1:${portB}/api/proxy-clients/health`)).json();
  const text = JSON.stringify(listed);
  assert.ok(text.includes("proxy-1"), text);
  assert.ok(text.includes("Гостиная"), text);

  // The page's connect deadline is 30 s; with no browser socket open the old
  // slot stands by at once.
  await waitFor(async () => (await instanceOf(portA))?.state === "standby", "slot a standing by");
  assert.equal((await fetch(`http://127.0.0.1:${portA}/api/proxy-clients/health`)).status, 503);
  assert.equal(await tunnelUpgradeStatus(portA), 503);
  assert.equal(await tunnelUpgradeStatus(portB), 101);
  // The handover is not reachable through nginx, which marks what it forwards.
  const forwarded = await fetch(`http://127.0.0.1:${portB}/internal/hand-over`, { headers: { "x-forwarded-for": "203.0.113.9" } });
  assert.equal(forwarded.status, 404);
});
