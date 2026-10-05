import assert from "node:assert/strict";
import { mkdtemp, rm, statfs } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { handleHealthGet } from "../routes/health/get.js";

const reply = () => ({ status: 200, body: null, code(status) { this.status = status; return this; }, send(body) { this.body = body; return this; } });
const running = { isShuttingDown: false };

test("health states the free space of the cache filesystem and the cache reserve", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ttv-health-"));
  try {
    const answer = await handleHealthGet({}, reply(), { shutdownState: running, version: "1.2.3", diskDirectory: directory, diskReserveBytes: 256 * 1024 ** 2 });
    const fs = await statfs(directory);
    assert.equal(answer.body.ok, true);
    assert.equal(answer.body.disk.reserveBytes, 256 * 1024 ** 2);
    // The free space moves while other programs write; it is the same filesystem's figure.
    assert.ok(Math.abs(answer.body.disk.freeBytes - fs.bavail * fs.bsize) < 64 * 1024 ** 2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("health states no disk without a cache directory or when the filesystem cannot be read", async () => {
  const none = await handleHealthGet({}, reply(), { shutdownState: running, version: "1.2.3" });
  assert.equal(none.body.disk, null);
  const missing = await handleHealthGet({}, reply(), { shutdownState: running, version: "1.2.3", diskDirectory: join(tmpdir(), "ttv-health-absent-directory") });
  assert.equal(missing.body.disk, null);
});

test("health during shutdown still answers 503 without reading the disk", async () => {
  const answer = await handleHealthGet({}, reply(), { shutdownState: { isShuttingDown: true }, version: "1.2.3", diskDirectory: tmpdir() });
  assert.equal(answer.status, 503);
  assert.equal(answer.body.disk, undefined);
});
