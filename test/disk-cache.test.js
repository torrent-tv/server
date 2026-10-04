import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DiskCache } from "../services/cache/DiskCache.js";

test("server cache survives restarts and namespaces do not share values", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ttv-cache-"));
  let disk = new DiskCache({ directory, budgetBytes: 1024 * 1024, reserveBytes: 0 });
  try {
    await disk.namespace("tmdb").set("1", { title: "Film" }, 60000);
    await disk.namespace("subtitles").set("1", { vtt: "WEBVTT" }, 60000);
    await disk.close();
    disk = new DiskCache({ directory, budgetBytes: 1024 * 1024, reserveBytes: 0 });
    assert.deepEqual(await disk.namespace("tmdb").get("1"), { title: "Film" });
    assert.deepEqual(await disk.namespace("subtitles").get("1"), { vtt: "WEBVTT" });
    assert.equal(await disk.namespace("tmdb").get("absent"), undefined);
    assert.equal(await disk.namespace("tmdb").set("expired", {}, 0), false);
  } finally {
    await disk.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("cache refuses writes without the free-space reserve and still serves the caller", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ttv-cache-"));
  const disk = new DiskCache({ directory, reserveBytes: Number.MAX_SAFE_INTEGER });
  try {
    assert.equal(await disk.namespace("files").set("1", { vtt: "WEBVTT" }, 60000), false);
    assert.equal(await disk.namespace("files").get("1"), undefined);
  } finally { await disk.close(); await rm(directory, { recursive: true, force: true }); }
});

test("SQLite page overhead also evicts old entries instead of preventing every future write", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ttv-cache-"));
  let now = 1000;
  const disk = new DiskCache({ directory, budgetBytes: 32768, reserveBytes: 0, now: () => now++ });
  const values = disk.namespace("small");
  try {
    for (let index = 0; index < 100; index++) {
      assert.equal(await values.set(String(index), { text: "a".repeat(100) }, 60000), true);
    }
    assert.equal(await values.get("0"), undefined);
    assert.deepEqual(await values.get("99"), { text: "a".repeat(100) });
  } finally { await disk.close(); await rm(directory, { recursive: true, force: true }); }
});

test("disk eviction uses last access across namespaces, and expiry does not serve stale data", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ttv-cache-"));
  let now = 1000;
  const disk = new DiskCache({ directory, budgetBytes: 1024 * 1024, reserveBytes: 0, now: () => now++ });
  const movies = disk.namespace("tmdb");
  const files = disk.namespace("subtitles");
  const value = "a".repeat(300000);
  try {
    assert.equal(await files.set("a", value, 60000), true);
    assert.equal(await movies.set("b", value, 60000), true);
    assert.equal(await movies.set("c", value, 60000), true);
    assert.equal(await files.get("a"), value);
    assert.equal(await movies.set("d", value, 60000), true);
    assert.equal(await movies.get("b"), undefined);
    assert.equal(await files.get("a"), value);
    assert.equal(await files.set("expires", {}, 10), true);
    now += 11;
    assert.equal(await files.get("expires"), undefined);
  } finally { await disk.close(); await rm(directory, { recursive: true, force: true }); }
});
