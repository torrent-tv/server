/**
 * @file The page nginx serves is switched in one step to the release of the
 * instance that starts to serve, and the one before it is kept.
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { publishRelease } from "../services/static-release.js";

/** Whether this machine lets a process create a directory link. */
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

test("current follows the serving release and keeps one before it", async (t) => {
  const volume = await mkdtemp(join(tmpdir(), "static-release-"));
  t.after(() => rm(volume, { recursive: true, force: true }));
  if (!(await canLink(volume))) {
    t.skip("this machine does not allow symbolic links");
    return;
  }
  const log = () => {};
  await addRelease(volume, "0.39.5-a-1");
  await addRelease(volume, "0.40.0-b-2");

  await publishRelease({ volumeDir: volume, release: "0.39.5-a-1", log });
  assert.equal(await readFile(join(volume, "current", "index.html"), "utf8"), "0.39.5-a-1");
  // Nothing was served before it, so nothing else is kept.
  assert.deepEqual(await readdir(join(volume, "releases")), ["0.39.5-a-1"]);

  await addRelease(volume, "0.40.0-b-2");
  await publishRelease({ volumeDir: volume, release: "0.40.0-b-2", log });
  assert.equal(await readFile(join(volume, "current", "index.html"), "utf8"), "0.40.0-b-2");
  assert.deepEqual((await readdir(join(volume, "releases"))).sort(), ["0.39.5-a-1", "0.40.0-b-2"]);

  await addRelease(volume, "0.41.0-a-3");
  await publishRelease({ volumeDir: volume, release: "0.41.0-a-3", log });
  assert.deepEqual((await readdir(join(volume, "releases"))).sort(), ["0.40.0-b-2", "0.41.0-a-3"]);
  assert.deepEqual((await readdir(volume)).sort(), ["current", "releases"]);
});
