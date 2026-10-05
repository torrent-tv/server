import { readdir, readlink, rename, rm, symlink } from "node:fs/promises";
import { basename, join } from "node:path";

/**
 * Make this instance's copy of the page the one nginx serves.
 *
 * Each server container copies its page into `releases/<name>` of the shared
 * volume when it starts (`docker-entrypoint.sh`), and nginx serves whatever
 * `current` points to. The instance that starts to serve repoints `current` by
 * renaming a new link over it, which replaces it in one step: no request sees
 * an empty directory, and the new page appears together with the server that
 * answers it, not when its container starts. The previous release is kept, so
 * a page loaded just before the switch can still fetch its modules; every
 * older one is removed.
 *
 * @param {{ volumeDir: string, release: string, log?: (line: string) => void }} options
 * @returns {Promise<void>}
 */
export async function publishRelease({ volumeDir, release, log = (line) => console.log(line) }) {
  const releasesDir = join(volumeDir, "releases");
  const link = join(volumeDir, "current");
  let previous = null;
  try {
    previous = basename(await readlink(link));
  } catch {
    // silent-ok: no link yet, the first release on this volume.
  }
  if (previous !== release) {
    const temporary = join(volumeDir, `current.${process.pid}`);
    await rm(temporary, { force: true });
    await symlink(join("releases", release), temporary);
    await rename(temporary, link);
    log(`[static] nginx now serves release ${release} (was ${previous ?? "none"})`);
  }
  for (const name of await readdir(releasesDir)) {
    if (name !== release && name !== previous) {
      await rm(join(releasesDir, name), { recursive: true, force: true });
    }
  }
}
