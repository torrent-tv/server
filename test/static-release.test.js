/**
 * @file The page nginx serves is switched in one step to the release of the
 * instance that starts to serve, and nothing the other slot holds is removed.
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { publishRelease, slotOfRelease } from "../services/static-release.js";

/** Whether this machine lets a process create a symbolic link. */
async function canLink(dir) {
  try {
    await symlink("nowhere", join(dir, "probe"));
    await rm(join(dir, "probe"));
    return true;
  } catch {
    return false;
  }
}

async function addRelease(volume, name) {
  await mkdir(join(volume, "releases", name), { recursive: true });
  await writeFile(join(volume, "releases", name, "index.html"), name);
}

test("a release directory names its slot", () => {
  assert.equal(slotOfRelease("0.41.0-a-1791238601"), "a");
  assert.equal(slotOfRelease("0.41.0-b-1791238600"), "b");
  assert.equal(slotOfRelease("something-else"), null);
});

test("current follows the serving release; only the slot's own older copies go", async (t) => {
  const volume = await mkdtemp(join(tmpdir(), "static-release-"));
  t.after(() => rm(volume, { recursive: true, force: true }));
  if (!(await canLink(volume))) {
    t.skip("this machine does not allow symbolic links");
    return;
  }
  const log = () => {};
  const list = async () => (await readdir(join(volume, "releases"))).sort();

  // Both slots start together: b serves first while a is still writing its copy.
  await addRelease(volume, "0.41.0-b-2");
  await addRelease(volume, "0.41.0-a-3");
  await publishRelease({ volumeDir: volume, release: "0.41.0-b-2", log });
  assert.deepEqual(await list(), ["0.41.0-a-3", "0.41.0-b-2"]);
  // a takes over: the copy it wrote is there to be served.
  await publishRelease({ volumeDir: volume, release: "0.41.0-a-3", log });
  assert.equal(await readFile(join(volume, "current", "index.html"), "utf8"), "0.41.0-a-3");

  // A release into b: b's older copy goes, a's stays for pages loaded before.
  await addRelease(volume, "0.42.0-b-4");
  await publishRelease({ volumeDir: volume, release: "0.42.0-b-4", log });
  assert.equal(await readFile(join(volume, "current", "index.html"), "utf8"), "0.42.0-b-4");
  assert.deepEqual(await list(), ["0.41.0-a-3", "0.42.0-b-4"]);
  assert.deepEqual((await readdir(volume)).sort(), ["current", "releases"]);
});
