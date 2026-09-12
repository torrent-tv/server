/**
 * @file The browser and the proxy read ONE statement of what is in a torrent,
 * and this is the wiring that lets them.
 *
 * The module is a package. Under Node it resolves out of `node_modules`; in the
 * browser the same bare name is pointed at the file the server serves, by the
 * import map in `index.html`. Three things have to agree for that to work — the
 * map, the static route and the files the page actually asks for — and if any
 * of them is wrong the page dies at load with a resolution error, which is the
 * failure `public-parses` was written for after `loading.js` stopped parsing and
 * took the whole application with it.
 *
 * None of it is visible to a unit test of the classification itself, so it is
 * checked here.
 */

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGE = "@torrent-tv/torrent-contents";
const SERVED_AT = "/vendor/torrent-contents/";
const require = createRequire(import.meta.url);

/**
 * Every `.js` file under a directory, recursively.
 *
 * @param {string} directory
 * @returns {string[]}
 */
function scriptsUnder(directory) {
  const found = [];
  for (const entry of readdirSync(directory)) {
    const full = path.join(directory, entry);
    if (statSync(full).isDirectory()) {
      found.push(...scriptsUnder(full));
    } else if (entry.endsWith(".js")) {
      found.push(full);
    }
  }
  return found;
}

test("the page maps the package name to where the server serves it", () => {
  const html = readFileSync(path.join(ROOT, "public", "index.html"), "utf8");
  const block = html.match(/<script type="importmap">([\s\S]*?)<\/script>/);
  assert.ok(block, "the page has no import map, so a bare specifier resolves to nothing");
  const map = JSON.parse(block[1]);
  assert.equal(map.imports[`${PACKAGE}/`], SERVED_AT);
});

test("the server serves that prefix from the installed package", () => {
  const source = readFileSync(path.join(ROOT, "server.js"), "utf8");
  assert.match(source, /node_modules\/@torrent-tv\/torrent-contents/);
  assert.ok(
    source.includes(`prefix: "${SERVED_AT}"`),
    "the prefix the import map points at is not served"
  );
});

test("every file the page asks for by that name is in the package", () => {
  const asked = new Set();
  for (const file of scriptsUnder(path.join(ROOT, "public"))) {
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(/from "@torrent-tv\/torrent-contents\/([^"]+)"/g)) {
      asked.add(match[1]);
    }
  }
  assert.ok(asked.size > 0, "nothing reads the shared statement, so it is not shared");
  for (const entry of asked) {
    // Resolved the way Node will resolve it, which also proves the package's
    // own `exports` list names the file: a file present in the package but not
    // exported is unreachable by this spelling.
    assert.doesNotThrow(
      () => require.resolve(`${PACKAGE}/${entry}`),
      `${PACKAGE}/${entry} is asked for and cannot be resolved`
    );
  }
});

test("the package it reads is the proxy's own source, not a copy of it", () => {
  // One owner means one file. The package is published FROM the proxy's
  // `services/torrent`, so what is installed here must be byte-identical to
  // what runs there — and when it is not, this says so before a torrent is
  // classified two ways again.
  const installed = path.dirname(require.resolve(`${PACKAGE}/files.js`));
  const source = path.join(ROOT, "..", "proxy", "services", "torrent");
  let theirs;
  try {
    theirs = readFileSync(path.join(source, "files.js"), "utf8");
  } catch {
    // The proxy is a separate repository and is not always checked out beside
    // this one; there is nothing to compare against then.
    return;
  }
  assert.equal(
    readFileSync(path.join(installed, "files.js"), "utf8"),
    theirs,
    "the installed package and the proxy's source have diverged"
  );
});
