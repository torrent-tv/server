/**
 * @file Every script served to the browser must at least PARSE.
 *
 * This is not a style check. On 2026-08-15 a private class field was written
 * into a method body instead of the class, `loading.js` stopped parsing, and
 * the whole application died for every viewer — a torrent waited twenty-five
 * seconds and then failed, with nothing in the proxy's log because no request
 * ever left the browser.
 *
 * Nothing caught it. The linter's rules do not cover an undeclared private
 * field, and the test suite never imports this file — it needs a DOM. What
 * would have caught it is asking whether the file parses at all, which costs
 * milliseconds per file.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public");

/**
 * Every `.js` file under a directory, recursively.
 *
 * @param {string} directory
 * @returns {string[]}
 */
function scriptsUnder(directory) {
  const found = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      found.push(...scriptsUnder(entryPath));
    } else if (entry.isFile() && entry.name.endsWith(".js")) {
      found.push(entryPath);
    }
  }
  return found;
}

test("every script served to the browser parses", () => {
  const scripts = scriptsUnder(PUBLIC_DIR);
  assert.ok(scripts.length > 10, "the public directory should hold the app's scripts");
  /** @type {string[]} */
  const broken = [];
  for (const script of scripts) {
    try {
      // `--check` parses as a module and reports syntax errors, which is
      // exactly what the browser does before running a line of it.
      execFileSync(process.execPath, ["--check", script], { stdio: "pipe" });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      broken.push(`${path.relative(PUBLIC_DIR, script)}: ${detail.split("\n").slice(0, 3).join(" ")}`);
    }
  }
  assert.deepEqual(broken, [], "a script that does not parse takes the whole application with it");
});
