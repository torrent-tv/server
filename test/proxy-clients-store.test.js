import test from "node:test";
import assert from "node:assert/strict";
import { createProxyClientsStore } from "../store/proxy-clients-store.js";

test("disconnected proxy records expire after their idle period", () => {
  const store = createProxyClientsStore();
  const record = store.upsertClient({ id: "old", name: "old", baseUrl: "http://old" });

  assert.equal(store.pruneDisconnected({
    isConnected: () => false,
    now: Date.parse(record.lastSeenAt) + 1001,
    maxIdleMs: 1000
  }), 1);
  assert.deepEqual(store.listClients(), []);
});

test("connected proxies and recently disconnected proxies keep their records", () => {
  const store = createProxyClientsStore();
  const old = store.upsertClient({ id: "connected", name: "connected", baseUrl: "http://connected" });
  old.lastSeenAt = new Date(Date.now() - 120_000).toISOString();
  const recent = store.upsertClient({ id: "recent", name: "recent", baseUrl: "http://recent" });
  const now = Date.now();

  assert.equal(store.pruneDisconnected({
    isConnected: (id) => id === "connected",
    now,
    maxIdleMs: 60_000
  }), 0);
  assert.deepEqual(store.listClients().map(({ id }) => id), ["connected", "recent"]);
  assert.ok(now - Date.parse(recent.lastSeenAt) < 60_000);
});
