import test from "node:test";
import assert from "node:assert/strict";
import { TorrentSession } from "../public/domain/torrent-session.js";

test("an older proxy cannot be cached as supporting map playback", async () => {
  const session = new TorrentSession(() => {});
  session.current = { sourceType: "magnet", sourceValue: "metadata-only" };
  let registrations = 0;
  const transport = { baseUrl: "proxy", fetch: async () => {
    registrations++;
    return { ok: true, json: async () => ({ sourceKey: "source" }) };
  } };
  await assert.rejects(session.registerSourceOnProxy(transport), /proxy needs an update/);
  assert.equal(session.proxySourceKeyCache.size, 0);
  transport.fetch = async (_path, options) => {
    registrations++;
    assert.equal(JSON.parse(options.body).consumerId, session.consumerId);
    return { ok: true, json: async () => ({ sourceKey: "source", playbackMapVersion: 1 }) };
  };
  assert.equal(await session.registerSourceOnProxy(transport), "source");
  assert.equal(await session.registerSourceOnProxy(transport), "source");
  assert.equal(registrations, 2);
});
