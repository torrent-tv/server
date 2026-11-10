import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

// The signalling handshake lives in one module. Needles are built in halves so
// this file never matches its own scan (and test/ is not scanned anyway).
const root = new URL("../public/", import.meta.url).pathname;
const SESSION = join(root, "domain/transport/signalling-session.js");

function sourceLines(dir = root) {
  const lines = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) { lines.push(...sourceLines(path)); continue; }
    if (!/\.(js|mjs|html|css)$/.test(entry.name)) continue;
    readFileSync(path, "utf8").split("\n").forEach((text, index) => lines.push({ path, line: index + 1, text }));
  }
  return lines;
}

const matching = needle => sourceLines().filter(({ text }) => text.includes(needle));
const where = found => found.map(({ path, line }) => `${path.slice(root.length)}:${line}`).join(", ");

test("the signalling endpoint is written once, in signalling-session.js", () => {
  const found = matching("/ws/" + "browser-signal");
  assert.equal(found.length, 1, `found ${found.length}: ${where(found)}`);
  assert.equal(found[0].path, SESSION, where(found));
});

test("the Chromium SCTP init fix is written once, in signalling-session.js", () => {
  const found = matching("sctp" + "-init");
  assert.equal(found.length, 1, `found ${found.length}: ${where(found)}`);
  assert.equal(found[0].path, SESSION, where(found));
});

test("the legacy control path is gone", () => {
  const found = matching("open" + "LegacyControl");
  assert.equal(found.length, 0, `still present: ${where(found)}`);
});

test("signalling-session.js exists and exports a session", async () => {
  assert.ok(existsSync(SESSION), "public/domain/transport/signalling-session.js is missing");
  const module = await import(SESSION);
  assert.ok(Object.values(module).some(value => typeof value === "function"), "no exported class or function");
});

test("no caller passes and the session does not read the retired onAnswered option", { todo: "S4" }, () => {
  const found = matching("on" + "Answered");
  assert.equal(found.length, 0, `still present: ${where(found)}`);
});
