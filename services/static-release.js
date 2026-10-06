import { readdir, readlink, rename, rm, symlink } from "node:fs/promises";
import { basename, join } from "node:path";

/**
 * The slot a release directory belongs to. The entrypoint names it
 * `<version>-<slot>-<start time>`.
 *
 * @param {string} name
 * @returns {string | null}
 */
export function slotOfRelease(name) {
  return /^.+-([^-]+)-\d+$/.exec(name)?.[1] ?? null;
}

/**
 * Make this instance's copy of the page the one nginx serves.
 *
 * Each server container copies its page into `releases/<version>-<slot>-<start
 * time>` of the shared volume when it starts (`docker-entrypoint.sh`), and
 * nginx serves whatever `current` points to. The instance that starts to serve
 * repoints `current` by renaming a new link over it, which replaces it in one
 * step: no request sees an empty directory, and the new page appears together
 * with the server that answers it, not when its container starts.
 *
 * Only this slot's earlier copies are removed. The other slot's copy is either
 * the page served until now, which a page loaded just before the switch still
 * fetches its modules from, or one that slot is writing at this moment because
 * it is starting — removing it would leave `current` pointing at nothing once
 * that slot serves (field 2026-10-05, the first start of both slots).
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
    // Made inside releases/, which the other slot's entrypoint does not empty,
    // and moved over `current`; the link's text is read from where it lands.
    const temporary = join(releasesDir, `.current.${process.pid}`);
    await rm(temporary, { force: true });
    await symlink(join("releases", release), temporary);
    await rename(temporary, link);
    log(`[static] nginx now serves release ${release} (was ${previous ?? "none"})`);
  }
  const slot = slotOfRelease(release);
  for (const name of await readdir(releasesDir)) {
    if (name !== release && slotOfRelease(name) === slot) {
      await rm(join(releasesDir, name), { recursive: true, force: true });
    }
  }
}
