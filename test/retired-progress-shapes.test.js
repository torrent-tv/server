import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// The wait the viewer sees has one source, `playbackReadiness` read by
// `WaitingModel` (torrent-tv/meta#288). The second wait estimate, the progress
// bar setter and the event that fed it were removed from the page; nothing may
// bring them back under the same names. The names are written in two halves so
// that this file does not contain what it looks for.
const RETIRED = [
  ["wait", "Estimate"],
  ["set", "Progress"],
  ["#set", "PhaseProgress"],
  ["SET_", "PROGRESS"]
].map(parts => parts.join(""));

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const TEXT = /\.(?:js|mjs|cjs|html|css|md|json)$/;

/**
 * Every text source under a directory, recursively.
 *
 * @param {string} directory
 * @returns {string[]}
 */
function sourcesUnder(directory) {
  const found = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      found.push(...sourcesUnder(entryPath));
    } else if (entry.isFile() && TEXT.test(entry.name)) {
      found.push(entryPath);
    }
  }
  return found;
}

test("the page and its tests do not mention the retired progress shapes", () => {
  const matches = [];
  for (const file of ["public", "test"].flatMap(directory => sourcesUnder(path.join(root, directory)))) {
    readFileSync(file, "utf8").split(/\r?\n/).forEach((line, index) => {
      for (const name of RETIRED) {
        if (line.includes(name)) matches.push(`${path.relative(root, file)}:${index + 1} ${name}`);
      }
    });
  }
  assert.deepEqual(matches, []);
});
