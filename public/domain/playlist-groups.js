/**
 * @file How the playlist lays out the pictures of a torrent: which ones sit in
 * a collapsible group of their own folder, and what each row is called.
 *
 * This is presentation, not classification. What each file IS and the order the
 * files come in are answered once, by the proxy (`Contents.js`, `GET
 * /api/sources/:key/files`), and nothing here second-guesses either: no name is
 * interpreted and no file is moved. The only input is the folder part of the
 * path the proxy already sent, which says where the release put a file and
 * nothing about what it is.
 *
 * If a folder ever has to MEAN something — "the next episode" for a countdown
 * at the end of one, or a season number matched against metadata — that is a
 * statement about the torrent and belongs to the proxy, next to the reading
 * order. It must not grow here into a third classification.
 */

/**
 * The rule that decides whether a folder becomes a group, derived from what a
 * group is for: it hides part of the list and leaves the rest in view. So a
 * folder is a group when it holds at least two pictures (one would be a click
 * for nothing) and not all of them (a group holding everything hides nothing).
 * Measured on the 148 test torrents on 2026-09-30: 145 stay flat, and the one
 * pack that keeps a folder per performer has 22 folders holding a single
 * picture, which stay plain rows.
 */
const MIN_GROUP_SIZE = 2;

/**
 * @typedef {{ index?: number, relativePath?: string, path?: string, name?: string, displayName?: string }} PlaylistFile
 * @typedef {{ kind: "file", file: PlaylistFile, label: string }} PlaylistFileRow
 * @typedef {{ kind: "group", folder: string, label: string, files: Array<{ file: PlaylistFile, label: string }> }} PlaylistGroupRow
 * @typedef {object} PlaylistNaming - Names that come from outside the torrent
 *   (a metadata provider), used instead of the file's own where they exist.
 * @property {(file: PlaylistFile, where: { grouped: boolean }) => string | null} [fileLabel]
 * @property {(folder: string, files: PlaylistFile[]) => string | null} [groupLabel]
 */

/**
 * The playlist's rows, in the order the files arrived.
 *
 * A group takes the place of its first file, which in the proxy's reading order
 * (by folder, then by name) is where its files already are. The shared `video`
 * list is not changed: the shorter name a file gets inside its group is the
 * playlist's alone, because other parts of the page name the same file without
 * the group around it.
 *
 * @param {PlaylistFile[]} files - The pictures, as `PLAYER:SET_MEDIA_FILES` carries them.
 * @param {PlaylistNaming} [naming] - Names to show instead of the file's own;
 *   a `null` answer keeps the file's own. Grouping does not depend on it.
 * @returns {Array<PlaylistFileRow | PlaylistGroupRow>}
 */
export function playlistRows(files, naming = {}) {
  const list = Array.isArray(files) ? files : [];
  /** @type {Map<string, PlaylistFile[]>} */
  const byFolder = new Map();
  for (const file of list) {
    const folder = naming.groupKey?.(file) ?? folderOf(file);
    if (folder.length > 0) {
      byFolder.set(folder, [...(byFolder.get(folder) ?? []), file]);
    }
  }
  const isGroup = (folder) => {
    const size = byFolder.get(folder)?.length ?? 0;
    return folder.startsWith("season:") || (size >= MIN_GROUP_SIZE && size < list.length);
  };

  /** @type {Array<PlaylistFileRow | PlaylistGroupRow>} */
  const rows = [];
  const placed = new Set();
  for (const file of list) {
    const folder = naming.groupKey?.(file) ?? folderOf(file);
    if (!isGroup(folder)) {
      rows.push({ kind: "file", file, label: naming.fileLabel?.(file, { grouped: false }) ?? labelOf(file) });
      continue;
    }
    if (placed.has(folder)) {
      continue;
    }
    placed.add(folder);
    const members = byFolder.get(folder);
    rows.push({
      kind: "group",
      folder,
      label: naming.groupLabel?.(folder, members) ?? folder,
      files: members.map((member) => ({
        file: member,
        label: naming.fileLabel?.(member, { grouped: true }) ?? labelInside(member, folder)
      }))
    });
  }
  return rows;
}

/**
 * @param {PlaylistFile} file
 * @returns {string} The folder the file sits in, relative to the torrent's root; empty at the root.
 */
function folderOf(file) {
  const path = typeof file?.relativePath === "string" ? file.relativePath : "";
  const slash = path.lastIndexOf("/");
  return slash > 0 ? path.slice(0, slash) : "";
}

/**
 * The name the list already worked out for the file — see `withDisplayNames` in
 * `torrent-parser.js`.
 *
 * @param {PlaylistFile} file
 * @returns {string}
 */
function labelOf(file) {
  if (typeof file?.displayName === "string" && file.displayName.length > 0) {
    return file.displayName;
  }
  if (typeof file?.relativePath === "string" && file.relativePath.length > 0) {
    return file.relativePath;
  }
  return String(file?.name ?? "Video");
}

/**
 * The file's name without the folder its group already shows.
 *
 * @param {PlaylistFile} file
 * @param {string} folder
 * @returns {string}
 */
function labelInside(file, folder) {
  const label = labelOf(file);
  const prefix = `${folder}/`;
  const inside = label.startsWith(prefix) ? label.slice(prefix.length).trim() : label;
  return inside.length > 0 ? inside : label;
}
