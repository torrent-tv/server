/**
 * @file `node server.js --check` loads every module of the server and
 * registers every route and plugin, then exits 0 without listening and
 * without taking the instance role (torrent-tv/meta#302, AC-S1, AC-S2).
 *
 * The image runs it in its final stage, so an image that cannot load the
 * server fails to build. The child is started from the repository root with
 * `PORT` set to a port that is free on this machine and without the
 * variables that would make it reach anything outside the process. A child
 * that prints `[server] Listening on` is killed at once.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { before, test } from "node:test";
import getPort from "get-port";

const SERVER_ROOT = fileURLToPath(new URL("..", import.meta.url));
const CHECK_LINE = "[server] check: every module loaded; not listening";
const LISTENING = "[server] Listening on";
const OUTSIDE = [
  "SERVER_PEER",
  "SERVER_SLOT",
  "SERVER_CACHE_DIR",
  "SERVER_CACHE_MIB",
  "SERVER_CACHE_RESERVE_MIB",
  "STATIC_VOLUME_DIR",
  "STATIC_RELEASE",
  "TMDB_READ_TOKEN",
  "THEPORNDB_API_KEY",
  "STASHDB_API_KEY",
  "PROXY_TOKEN"
];

/**
 * Runs `node server.js --check` until it exits, or kills it when it listens.
 *
 * @param {Record<string, string>} extraEnv
 * @returns {Promise<{ code: number | null, signal: string | null, killedForListening: boolean, stdout: string, stderr: string, port: number }>}
 */
async function runCheck(extraEnv = {}) {
  const port = await getPort();
  const env = { ...process.env, PORT: String(port), ...extraEnv };
  for (const name of OUTSIDE) if (!(name in extraEnv)) delete env[name];
  const child = spawn(process.execPath, ["server.js", "--check"], {
    cwd: SERVER_ROOT,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 60_000,
    killSignal: "SIGKILL"
  });
  let stdout = "";
  let stderr = "";
  let killedForListening = false;
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
    if (!killedForListening && stdout.includes(LISTENING)) {
      killedForListening = true;
      child.kill("SIGKILL");
    }
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const [code, signal] = await new Promise((resolve) => child.on("close", (c, s) => resolve([c, s])));
  return { code, signal, killedForListening, stdout, stderr, port };
}

/** @param {number} port @returns {Promise<boolean>} whether this machine can listen on the port now */
function portIsFree(port) {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once("error", () => resolve(false));
    probe.listen({ port, host: "0.0.0.0", exclusive: true }, () => probe.close(() => resolve(true)));
  });
}

/** @param {Awaited<ReturnType<typeof runCheck>>} r */
function said(r) {
  return `exit ${r.code}, signal ${r.signal}, killed for listening: ${r.killedForListening}\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`;
}

let checked;
let freeAfter;

before(async () => {
  checked = await runCheck();
  freeAfter = await portIsFree(checked.port);
});

test("--check exits 0", () => {
  assert.equal(checked.code, 0, said(checked));
});

test("--check prints the check line on stdout", () => {
  assert.ok(checked.stdout.split("\n").includes(CHECK_LINE), said(checked));
});

test("--check never listens", () => {
  assert.equal(checked.stdout.includes(LISTENING), false, said(checked));
});

test("--check exits by itself and leaves the PORT it was given free", () => {
  assert.equal(checked.killedForListening, false, said(checked));
  assert.equal(checked.signal, null, said(checked));
  assert.equal(freeAfter, true, `port ${checked.port} is still taken\n${said(checked)}`);
});

test("--check exits non-zero when the server fails to load", async () => {
  const r = await runCheck({ SERVER_CACHE_MIB: "1" });
  assert.notEqual(r.code, 0, said(r));
  assert.notEqual(r.code, null, said(r));
  assert.equal(r.stdout.includes(CHECK_LINE), false, said(r));
  assert.equal(r.stdout.includes(LISTENING), false, said(r));
});
