/**
 * @file The server chooses the proxy from what proxies say about themselves
 * (torrent-tv/meta#36): one request, one proxy, and the films a proxy holds
 * never leave the server.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import getPort from "get-port";
import { WebSocket } from "ws";
import { chooseProxy } from "../services/proxy-choice.js";

const serverEntry = fileURLToPath(new URL("../server.js", import.meta.url));
const FILM = "84acab5f03b1477337d989d05578c84519585af7";

const proxy = (id, extra = {}) => ({ id, name: id, baseUrl: "", metrics: { cpuLoad: 0.2, memFree: 0.5 }, rttMs: 10, reachable: true, sameNetwork: false, holdsThisFilm: false, ...extra });

test("a proxy that could not be reached is left out of the next choice, and only of it", () => {
  const candidates = [proxy("a", { metrics: { cpuLoad: 0.1, memFree: 0.9 } }), proxy("b")];
  assert.equal(chooseProxy(candidates).chosen.id, "a");
  assert.equal(chooseProxy(candidates, { tried: ["a"] }).chosen.id, "b");
  assert.equal(chooseProxy(candidates, { tried: ["a", "b"] }).chosen, null);
  assert.equal(chooseProxy(candidates, { onlyIds: ["b"] }).chosen.id, "b");
});

test("the proxy in hand is kept unless another holds the film and it does not", () => {
  const idle = proxy("idle", { metrics: { cpuLoad: 0, memFree: 1 } });
  const busy = proxy("busy", { metrics: { cpuLoad: 0.8, memFree: 0.2 } });
  // Nobody holds the film: a difference in load is not worth a reconnect.
  assert.equal(chooseProxy([idle, busy], { current: "busy" }).chosen.id, "busy");
  // Another holds it and has room: move there.
  assert.equal(chooseProxy([idle, { ...busy, holdsThisFilm: true }], { current: "idle" }).chosen.id, "busy");
  // Both hold it: stay.
  assert.equal(chooseProxy([{ ...idle, holdsThisFilm: true }, { ...busy, holdsThisFilm: true }], { current: "busy" }).chosen.id, "busy");
  // The holder has no room for one more encode: it is not preferred.
  assert.equal(chooseProxy([idle, { ...busy, holdsThisFilm: true, metrics: { ...busy.metrics, encodeSpeedX: 0.9 } }], { current: "idle" }).chosen.id, "idle");
});

async function waitFor(until, what, limit = 120_000) {
  const deadline = Date.now() + limit;
  while (!(await until())) {
    if (Date.now() > deadline) throw new Error(`${what} never happened`);
    await new Promise((resolve) => { setTimeout(resolve, 20); });
  }
}

test("what a proxy says over its tunnel decides the choice, and what it holds stays on the server", async (t) => {
  const port = await getPort();
  const child = spawn(process.execPath, [serverEntry], {
    env: { ...process.env, PORT: String(port), SERVER_SLOT: "a", SERVER_CACHE_DIR: "", TMDB_READ_TOKEN_FILE: "" },
    stdio: ["ignore", "pipe", "pipe"]
  });
  const output = [];
  child.stdout.on("data", (data) => output.push(String(data)));
  child.stderr.on("data", (data) => output.push(String(data)));
  let socket = null;
  t.after(() => { socket?.terminate(); child.kill(); });
  await waitFor(async () => {
    try { return (await fetch(`http://127.0.0.1:${port}/healthz`)).ok; } catch { return false; }
  }, `the server listening\n${output.join("")}`);

  socket = new WebSocket(`ws://127.0.0.1:${port}/ws/proxy-tunnel`, {
    headers: { "x-proxy-id": "proxy-1", "x-proxy-name": "proxy-1", "x-proxy-base-url": "http://192.168.1.7:9090" }
  });
  socket.on("open", () => socket.send(JSON.stringify({
    type: "proxy-state",
    metrics: { cpuLoad: 0.25, memFree: 0.6, encodeSpeedX: 3 },
    holds: [{ infoHash: FILM, progress: 0.4, bytes: 1, wholeFiles: [] }]
  })));
  const choose = async (body) => (await fetch(`http://127.0.0.1:${port}/api/proxy-clients/choose`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body)
  })).json();
  await waitFor(async () => (await choose({ infoHash: FILM })).chosen?.holdsThisFilm === true, "the proxy's state reaching the choice");

  const answer = await choose({ infoHash: FILM });
  assert.equal(answer.chosen.id, "proxy-1");
  assert.equal(answer.chosen.metrics.encodeSpeedX, 3);
  assert.equal((await choose({ infoHash: FILM, tried: [{ id: "proxy-1", error: "ICE failed" }] })).chosen, null);

  // The proxy's keepalive is answered with a probe; the proxy's echo is the round trip.
  socket.on("message", (data) => {
    const message = JSON.parse(String(data));
    if (message.type === "rtt-probe") socket.send(JSON.stringify({ type: "rtt-echo", sentAt: message.sentAt }));
  });
  socket.send(JSON.stringify({ type: "ping" }));
  await waitFor(async () => typeof (await choose({})).chosen?.rttMs === "number", "the tunnel round trip measured");

  const health = await (await fetch(`http://127.0.0.1:${port}/api/proxy-clients/health`)).text();
  assert.ok(health.includes("proxy-1"), health);
  assert.ok(!health.includes(FILM), "the films a proxy holds are not listed");
  assert.ok(!JSON.stringify(answer).includes('"holds"'), "nor is the list sent with a choice");
});
