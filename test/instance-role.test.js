/**
 * @file Two server instances hand over without a moment in which neither
 * accepts pages, and the new one serves only once the proxies have moved.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { WebSocketServer } from "ws";

import { InstanceState, compareVersions, createInstanceRole, decideOnPeer } from "../services/instance-role.js";

async function waitFor(until, what, limit = 10_000) {
  const deadline = Date.now() + limit;
  while (!until()) {
    if (Date.now() > deadline) {
      throw new Error(`${what} never happened`);
    }
    await new Promise((resolve) => { setTimeout(resolve, 2); });
  }
}

test("versions compare by number, not by text", () => {
  assert.ok(compareVersions("0.40.0", "0.39.12") > 0);
  assert.ok(compareVersions("0.9.0", "0.10.0") < 0);
  assert.equal(compareVersions("1.2.3", "1.2.3"), 0);
});

test("a starting instance decides from what its peer says", () => {
  const self = { version: "0.40.0", slot: "b" };
  assert.equal(decideOnPeer(self, null), "serve");
  assert.equal(decideOnPeer(self, { state: "serving", version: "0.39.0", slot: "a" }), "take-over");
  assert.equal(decideOnPeer(self, { state: "serving", version: "0.40.0", slot: "a" }), "take-over");
  // The previous version restarting never replaces the current one.
  assert.equal(decideOnPeer(self, { state: "serving", version: "0.41.0", slot: "a" }), "standby");
  assert.equal(decideOnPeer(self, { state: "standby", version: "0.41.0", slot: "a" }), "serve");
  // Two starting together: the newer serves, then the slot that sorts first.
  assert.equal(decideOnPeer(self, { state: "starting", version: "0.39.0", slot: "a" }), "serve");
  assert.equal(decideOnPeer(self, { state: "starting", version: "0.40.0", slot: "a" }), "standby");
  assert.equal(decideOnPeer({ version: "0.40.0", slot: "a" }, { state: "starting", version: "0.40.0", slot: "b" }), "serve");
  assert.equal(decideOnPeer(self, { state: "handing-over", version: "0.39.0", slot: "a" }), "standby");
});

/**
 * The parts of the tunnel server and the signal hub a role uses, with proxies
 * that are plain records. A proxy that follows moves "moves" when asked: it
 * connects to `whereMovesGo`, as nginx would send it there.
 */
function fakeServer() {
  const proxies = new Map();
  let handler = () => {};
  let whereMovesGo = null;
  const tunnelServer = {
    connectedProxies: () => [...proxies.values()].map(({ proxyId, followsMoves }) => ({ proxyId, followsMoves })),
    askToMove: (proxyId) => { queueMicrotask(() => whereMovesGo?.connect(proxyId, true)); },
    closeAll: () => {
      for (const proxyId of [...proxies.keys()]) {
        proxies.delete(proxyId);
        handler(proxyId, false);
      }
    },
    setConnectionHandler: (h) => { handler = h; }
  };
  const browsers = { latest: null, closed: 0 };
  const signalHub = {
    latestOpenedAt: () => browsers.latest,
    closeAll: () => { browsers.closed += 1; browsers.latest = null; }
  };
  return {
    tunnelServer,
    signalHub,
    browsers,
    proxies,
    connect(proxyId, followsMoves) {
      proxies.set(proxyId, { proxyId, followsMoves });
      handler(proxyId, true);
    },
    disconnect(proxyId) {
      proxies.delete(proxyId);
      handler(proxyId, false);
    },
    movesGoTo(other) { whereMovesGo = other; }
  };
}

/** Serve one role's `/internal/hand-over` on a port of its own. */
async function listenFor(role) {
  const server = new WebSocketServer({ port: 0 });
  await new Promise((resolve) => { server.on("listening", resolve); });
  server.on("connection", (socket) => role.acceptPeer(socket));
  return { url: `ws://127.0.0.1:${server.address().port}`, close: () => new Promise((resolve) => { for (const c of server.clients) c.terminate(); server.close(() => resolve()); }) };
}

test("a release hands over: proxies move first, pages never go unanswered", async (t) => {
  const events = [];
  const old = fakeServer();
  const oldRole = createInstanceRole({
    slot: "a", version: "0.39.0", peerUrl: null, tunnelServer: old.tunnelServer, signalHub: old.signalHub,
    connectDeadlineMs: 50,
    onServe: () => { events.push("old serves"); },
    onLeave: () => { events.push("old leaves"); },
    log: () => {}
  });
  old.tunnelServer.setConnectionHandler((id, c) => oldRole.onProxyConnection(id, c));
  await oldRole.start();
  assert.equal(oldRole.describe().state, InstanceState.SERVING);
  old.connect("follower-1", true);
  old.connect("follower-2", true);
  old.connect("old-proxy", false);
  old.browsers.latest = Date.now();
  const listening = await listenFor(oldRole);
  t.after(() => listening.close());

  const fresh = fakeServer();
  const newRole = createInstanceRole({
    slot: "b", version: "0.40.0", peerUrl: listening.url, tunnelServer: fresh.tunnelServer, signalHub: fresh.signalHub,
    connectDeadlineMs: 50,
    onServe: () => { events.push("new serves"); },
    onLeave: () => { events.push("new leaves"); },
    log: () => {}
  });
  fresh.tunnelServer.setConnectionHandler((id, c) => newRole.onProxyConnection(id, c));
  old.movesGoTo(fresh);

  // Sample, on every tick, whether some instance accepts pages.
  let gap = false;
  let sampling = true;
  const sample = () => {
    if (!oldRole.acceptsPages() && !newRole.acceptsPages()) gap = true;
    if (sampling) setImmediate(sample);
  };
  sample();

  await newRole.start();
  await waitFor(() => newRole.describe().state === InstanceState.SERVING, "the new instance serving");
  await waitFor(() => oldRole.describe().state === InstanceState.STANDBY, "the old instance standing by");
  sampling = false;

  assert.equal(gap, false, "a moment came when no instance accepted pages");
  // The new instance had every proxy that follows moves before it served.
  assert.deepEqual([...fresh.proxies.keys()].sort(), ["follower-1", "follower-2"]);
  // One cache writer at a time: the old let go before the new opened.
  assert.deepEqual(events, ["old serves", "old leaves", "new serves"]);
  // The old instance closed its tunnels and browsers after draining.
  assert.equal(old.proxies.size, 0);
  assert.equal(old.browsers.closed, 1);
  assert.equal(oldRole.acceptsTunnels(), false);
});

test("a proxy that leaves during the handover is not waited for", async (t) => {
  const old = fakeServer();
  const oldRole = createInstanceRole({
    slot: "a", version: "0.39.0", peerUrl: null, tunnelServer: old.tunnelServer, signalHub: old.signalHub,
    connectDeadlineMs: 0, log: () => {}
  });
  old.tunnelServer.setConnectionHandler((id, c) => oldRole.onProxyConnection(id, c));
  await oldRole.start();
  old.connect("stays", true);
  old.connect("goes", true);
  const listening = await listenFor(oldRole);
  t.after(() => listening.close());

  const fresh = fakeServer();
  // Only "stays" arrives; "goes" disconnects from the old instance instead.
  old.tunnelServer.askToMove = (proxyId) => {
    queueMicrotask(() => {
      if (proxyId === "stays") fresh.connect(proxyId, true);
      else old.disconnect(proxyId);
    });
  };
  const newRole = createInstanceRole({
    slot: "b", version: "0.39.0", peerUrl: listening.url, tunnelServer: fresh.tunnelServer, signalHub: fresh.signalHub,
    connectDeadlineMs: 0, log: () => {}
  });
  fresh.tunnelServer.setConnectionHandler((id, c) => newRole.onProxyConnection(id, c));
  await newRole.start();
  await waitFor(() => newRole.describe().state === InstanceState.SERVING, "the new instance serving");
  await waitFor(() => oldRole.describe().state === InstanceState.STANDBY, "the old instance standing by");
});

test("the old instance serves again when the new one goes away mid-handover", async (t) => {
  const old = fakeServer();
  const events = [];
  const oldRole = createInstanceRole({
    slot: "a", version: "0.39.0", peerUrl: null, tunnelServer: old.tunnelServer, signalHub: old.signalHub,
    connectDeadlineMs: 0, log: () => {},
    onServe: () => { events.push("serves"); }
  });
  old.tunnelServer.setConnectionHandler((id, c) => oldRole.onProxyConnection(id, c));
  await oldRole.start();
  // A proxy that never arrives keeps the handover open.
  old.connect("slow", true);
  old.tunnelServer.askToMove = () => {};
  const listening = await listenFor(oldRole);
  t.after(() => listening.close());

  const fresh = fakeServer();
  const newRole = createInstanceRole({
    slot: "b", version: "0.40.0", peerUrl: listening.url, tunnelServer: fresh.tunnelServer, signalHub: fresh.signalHub,
    connectDeadlineMs: 0, log: () => {}
  });
  await newRole.start();
  await waitFor(() => oldRole.describe().state === InstanceState.HANDING_OVER, "the handover starting");
  assert.equal(oldRole.acceptsPages(), true);
  assert.equal(oldRole.acceptsTunnels(), false);
  await listening.close();
  await waitFor(() => oldRole.describe().state === InstanceState.SERVING, "the old instance serving again");
  assert.equal(oldRole.acceptsTunnels(), true);
  assert.deepEqual(events, ["serves", "serves"]);
});

test("an older instance starting beside a newer one stands by", async (t) => {
  const current = fakeServer();
  const currentRole = createInstanceRole({
    slot: "b", version: "0.40.0", peerUrl: null, tunnelServer: current.tunnelServer, signalHub: current.signalHub,
    connectDeadlineMs: 0, log: () => {}
  });
  await currentRole.start();
  const listening = await listenFor(currentRole);
  t.after(() => listening.close());
  const previous = fakeServer();
  const previousRole = createInstanceRole({
    slot: "a", version: "0.39.0", peerUrl: listening.url, tunnelServer: previous.tunnelServer, signalHub: previous.signalHub,
    connectDeadlineMs: 0, log: () => {}
  });
  await previousRole.start();
  await waitFor(() => previousRole.describe().state === InstanceState.STANDBY, "the older instance standing by");
  assert.equal(currentRole.describe().state, InstanceState.SERVING);
  assert.equal(previousRole.acceptsPages(), false);
});
