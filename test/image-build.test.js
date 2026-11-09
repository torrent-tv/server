/**
 * @file The server image checks itself in its final stage, and a CI `build`
 * job builds it before the release may run (torrent-tv/meta#302, AC-S3).
 *
 * `Dockerfile` and `.github/workflows/main.yml` are read as text. A
 * Dockerfile instruction is its lines joined across trailing backslashes,
 * with comment lines dropped, as Docker reads it. Nothing is built or run.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/** @param {string} file @returns {string} */
function read(file) {
  return readFileSync(new URL(`../${file}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
}

/** @returns {{ keyword: string, args: string }[][]} the instructions of each stage, in order */
function stages() {
  const found = [];
  let pending = "";
  for (const line of read("Dockerfile").split("\n")) {
    if (/^\s*#/.test(line)) continue;
    if (pending === "" && line.trim() === "") continue;
    const continued = /\\\s*$/.test(line);
    pending += `${continued ? line.replace(/\\\s*$/, "") : line} `;
    if (continued) continue;
    const text = pending.replace(/\s+/g, " ").trim();
    pending = "";
    const match = /^(\w+)\s*(.*)$/.exec(text);
    if (!match) continue;
    const keyword = match[1].toUpperCase();
    if (keyword === "FROM") found.push([]);
    found.at(-1)?.push({ keyword, args: match[2] });
  }
  return found;
}

/** @param {string} job @returns {string[]} the job's lines, without full-line comments */
function jobLines(job) {
  const lines = read(".github/workflows/main.yml")
    .split("\n")
    .filter((line) => !/^\s*#/.test(line));
  const start = lines.findIndex((line) => line === `  ${job}:`);
  assert.notEqual(start, -1, `main.yml has no job ${job}`);
  const body = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() !== "" && /^ {0,2}\S/.test(line)) break;
    body.push(line);
  }
  return body;
}

/** @param {string} job @returns {string[]} */
function needsOf(job) {
  const body = jobLines(job);
  const index = body.findIndex((line) => /^ {4}needs:/.test(line));
  assert.notEqual(index, -1, `job ${job} needs nothing`);
  const inline = body[index].replace(/^ {4}needs:\s*/, "").trim();
  if (inline.startsWith("[")) {
    return inline
      .replace(/[[\]]/g, "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  if (inline !== "") return [inline];
  const items = [];
  for (const line of body.slice(index + 1)) {
    const item = /^ {6}-\s*(\S+)/.exec(line);
    if (!item) break;
    items.push(item[1]);
  }
  return items;
}

test("the final stage runs node ./server.js --check as user app", () => {
  const instructions = stages().at(-1);
  const user = instructions.findIndex((i) => i.keyword === "USER" && i.args.trim() === "app");
  const check = instructions.findIndex((i) => i.keyword === "RUN" && /^node \.\/server\.js --check$/.test(i.args.trim()));
  assert.notEqual(user, -1, "the final stage has no USER app");
  assert.notEqual(check, -1, "the final stage does not run node ./server.js --check");
  assert.ok(user < check, "--check runs before USER app");
});

test("job build is named Image build and needs checks", () => {
  const body = jobLines("build");
  assert.ok(body.some((line) => /^ {4}name:\s*["']?Image build["']?\s*$/.test(line)), body.join("\n"));
  assert.deepEqual(needsOf("build"), ["checks"]);
});

test("job build builds the image", () => {
  assert.ok(
    jobLines("build").some((line) => /\bdocker build\b/.test(line)),
    "job build runs no docker build"
  );
});

test("release needs checks and build", () => {
  const needs = needsOf("release");
  assert.ok(needs.includes("checks"), `release needs ${JSON.stringify(needs)}`);
  assert.ok(needs.includes("build"), `release needs ${JSON.stringify(needs)}`);
});
