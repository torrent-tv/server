/**
 * @file No failure path may be silent.
 *
 * The rule this checks is the first half of roadmap item 12: a branch that
 * ABANDONS work must record what it decided and what it decided from. The
 * expensive lesson behind it is not from this repo — proxy 2.9.126 swallowed a
 * `RangeError` in a process-wide handler and the source stopped answering for
 * ever, while the symptoms pointed at a damaged audio track. A caught error
 * that nobody writes down is worse than a crash, because a crash at least names
 * itself.
 *
 * What is checked, mechanically: every `catch` block in the browser's own code
 * either logs, or re-throws, or is listed below with a reason. What is NOT
 * checked here is the other half of the rule — branches that change what the
 * viewer sees — which no regular expression can recognise; those are covered by
 * review.
 */

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public");

/**
 * Catch blocks that say nothing ON PURPOSE, each with the reason it is allowed.
 * A `catch` that belongs here is one where the failure is the expected answer
 * and carries no information — not one where logging was merely forgotten.
 */
const SILENCE_ALLOWED = new Map([
  ["domain/url-state.js", "a URL that does not parse IS the answer: there is no state in it"],
  ["domain/torrent-parser.js", "a file that does not parse as a torrent is reported to the caller, not logged twice"],
  ["domain/bencode.js", "same: malformed input is the return value"],
  ["domain/local-network-permission.js", "the probe's failure is the signal the caller acts on"]
]);

/**
 * What is silent TODAY, per file. They are not fixed in one edit — that is
 * roadmap item 12, done in passes — but the count may never grow, and every
 * pass lowers a number here.
 *
 * The totals were rebased on 2026-08-16 and the drop is NOT a pass. Two faults
 * in the rule itself, in opposite directions:
 *
 *   - it matched `throw` followed by a BACKSPACE character where a word
 *     boundary was meant, so no `catch` that re-throws counted as speaking and
 *     every one of them was tallied as silent. The check could therefore have
 *     been satisfied by twelve new silent blocks anywhere in the tree;
 *   - it judged comments along with code, so a silent `catch` commented "must
 *     never throw" scored as one that speaks. Comments are stripped now.
 *
 * Rebased against the corrected rule: 38 blocks, not 51.
 */
const SILENT_TODAY = new Map([
  ["components/loading/loading.js", 17],
  ["domain/webrtc-proxy.js", 4],
  ["components/media-session/media-session.js", 3],
  ["components/player/player.js", 3],
  ["domain/torrent-session.js", 3],
  ["shared/client-logger.js", 4],
  ["components/torrent/torrent.js", 2],
  ["components/proxy-selector/proxy-selector.js", 1],
  ["domain/net-report.js", 1]
]);

/**
 * Every `.js` under a directory, recursively.
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

/**
 * The body of every `catch` block in a source file, found by matching braces so
 * that nested blocks come out whole.
 *
 * @param {string} source
 * @returns {{ line: number, body: string }[]}
 */
function catchBodies(source) {
  const bodies = [];
  const pattern = /\bcatch\b\s*(?:\([^)]*\)\s*)?\{/g;
  let match = pattern.exec(source);
  while (match !== null) {
    let depth = 1;
    let index = match.index + match[0].length;
    while (index < source.length && depth > 0) {
      if (source[index] === "{") {
        depth += 1;
      } else if (source[index] === "}") {
        depth -= 1;
      }
      index += 1;
    }
    bodies.push({
      line: source.slice(0, match.index).split("\n").length,
      body: source.slice(match.index, index)
    });
    match = pattern.exec(source);
  }
  return bodies;
}

/**
 * What counts as a catch block speaking: it logs, it hands the failure to the
 * app's own logger, it re-throws, or it rejects.
 */
const SPEAKS = /console\.(debug|info|warn|error)|#logEvt|logEvent|onLog|\bthrow\b|reject\(/;

/**
 * The same source with comments removed. Deliberately crude — it is applied to
 * a catch body, where a `//` or `/* *​/` inside a string literal would be a
 * curiosity; what it must not do is let a comment vouch for the code.
 *
 * @param {string} body
 * @returns {string}
 */
function withoutComments(body) {
  return body.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
}

test("no new failure path is added that says nothing", () => {
  /** @type {Map<string, number>} */
  const counted = new Map();
  for (const script of scriptsUnder(PUBLIC_DIR)) {
    const relative = path.relative(PUBLIC_DIR, script).split(path.sep).join("/");
    if (SILENCE_ALLOWED.has(relative)) {
      continue;
    }
    const source = readFileSync(script, "utf8");
    for (const { body } of catchBodies(source)) {
      // Comments are stripped before the body is judged, because a catch block
      // that says nothing is not made to speak by the word "throw" appearing in
      // its own explanation. `client-logger.js` has exactly that — a silent
      // catch commented "forwarding logs must never throw" — and it was scored
      // as speaking. Left as it was, this rule could be satisfied by writing
      // "throw" into a comment, which is the opposite of what it is for.
      const speaks = SPEAKS.test(withoutComments(body));
      if (!speaks) {
        counted.set(relative, (counted.get(relative) ?? 0) + 1);
      }
    }
  }
  if (process.env.SILENT_BASELINE === "print") {
    for (const [file, count] of [...counted].sort((left, right) => right[1] - left[1])) {
      console.log(`  ["${file}", ${count}],`);
    }
  }
  /** @type {string[]} */
  const grew = [];
  /** @type {string[]} */
  const shrank = [];
  for (const [file, count] of counted) {
    const allowed = SILENT_TODAY.get(file) ?? 0;
    if (count > allowed) {
      grew.push(`${file}: ${count} silent catches, baseline ${allowed}`);
    } else if (count < allowed) {
      shrank.push(`${file}: ${count} now, baseline still says ${allowed}`);
    }
  }
  for (const [file, allowed] of SILENT_TODAY) {
    if (!counted.has(file) && allowed > 0) {
      shrank.push(`${file}: none left, baseline still says ${allowed}`);
    }
  }
  assert.deepEqual(grew, [], "a new failure path that says nothing — log it, re-throw it, or explain it in SILENCE_ALLOWED");
  assert.deepEqual(shrank, [], "these were fixed: lower the baseline in SILENT_TODAY so the ratchet holds");
});
