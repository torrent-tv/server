/**
 * @file What kind of release a torrent says it is, from where it came from.
 *
 * A `.torrent` file names the page of its release in `comment` and its trackers
 * in `announce`; a tracker that carries only one kind of material says the
 * category of everything on it. Measured on the 152 test files: `comment` is the
 * link to the release page in all of them (pornolab 33, rutor 24, LostFilm the
 * rest). A magnet link states neither, so it has no category from here; the
 * databases are still asked by the hash of the file and, when the film and anime
 * ones know nothing, by the name (`MetadataRegistry`).
 *
 * Only trackers that carry nothing but adult material are listed: a general
 * tracker (rutor, rutracker) says nothing about a single release.
 */

/** Hosts of trackers that carry only adult material. */
export const ADULT_TRACKER_HOSTS = Object.freeze(["pornolab.net"]);

/** @param {string} value @returns {string | null} The host of a URL in `value`, lower case. */
function hostOf(value) {
  const match = /^[a-z][a-z0-9+.-]*:\/\/([^/:?#\s]+)/iu.exec(String(value ?? "").trim());
  return match ? match[1].toLowerCase() : null;
}

/**
 * @param {{ comment?: string, announce?: string, announceList?: string[] } | null | undefined} torrent
 * @returns {"adult" | null} `null` when the torrent states nothing.
 */
export function categoryOfTorrent(torrent) {
  const hosts = [torrent?.comment, torrent?.announce, ...(torrent?.announceList ?? [])]
    .map((value) => hostOf(String(value ?? "").match(/https?:\/\/\S+|udp:\/\/\S+/iu)?.[0] ?? value))
    .filter(Boolean);
  return hosts.some((host) => ADULT_TRACKER_HOSTS.some((adult) => host === adult || host.endsWith(`.${adult}`))) ? "adult" : null;
}
