import { bytesToHex, bytesToUtf8, decodeBencode } from "./bencode.js";

/**
 * WHAT A TORRENT'S FILES ARE IS NOT DECIDED HERE ANY MORE.
 *
 * This module carried a list of video extensions, the picker beside it carried
 * a second and shorter pair of its own, and the proxy carried a third — and the
 * three had already diverged: measured 2026-09-12, `.dat` was offered here as
 * video and not counted there, which also decides whether a sidecar whose name
 * matches nothing can belong to the only video present. The proxy answers it
 * now, over the route that lists a source's files, and everything below either
 * reads the bytes this browser holds (the trackers and the web seeds, which
 * nothing else can see) or decides how a name is SHOWN.
 */

function normalizeBytes(value) {
  if (value instanceof Uint8Array) {
    return value;
  }
  return new Uint8Array();
}

function normalizeString(value) {
  if (typeof value === "string") {
    return value;
  }
  return bytesToUtf8(value);
}

function toNumber(value, fallback = 0) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  return fallback;
}

function toStringList(value) {
  if (typeof value === "string") {
    return [value];
  }
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => normalizeString(item))
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function parseMultiFile(baseName, filesNode) {
  if (!Array.isArray(filesNode)) {
    return [];
  }

  return filesNode.map((entry, index) => {
    const entryRecord =
      entry && typeof entry === "object" && !Array.isArray(entry) ? entry : {};
    const length = toNumber(entryRecord.length);
    const pathSegments = Array.isArray(entryRecord.path)
      ? entryRecord.path.map((segment) => normalizeString(segment))
      : [`file-${index}`];
    const relativePath = pathSegments.join("/");
    return {
      index,
      name: pathSegments[pathSegments.length - 1] ?? `file-${index}`,
      path: `${baseName}/${relativePath}`,
      relativePath,
      length
    };
  });
}

function parseSingleFile(name, length) {
  return [
    {
      index: 0,
      name,
      path: name,
      relativePath: name,
      length
    }
  ];
}

/**
 * The proxy's answer about a torrent, as the three lists the player and the
 * subtitle pipeline consume.
 *
 * The grouping is the proxy's — which files carry a picture, and which
 * soundtracks and subtitle files belong to each of them. All this does is put
 * the answer in the shape the rest of this page already speaks, and decide how
 * each name is SHOWN, which is the one half of it that is presentation.
 *
 * @param {Array<object>} files - The proxy's list, already normalized.
 * @param {Array<{ fileIndex: number, audio?: number[], subtitles?: number[] }>} items
 * @returns {{ video: object[], audio: object[], subtitles: object[] }}
 */
export function mediaFilesFrom(files, items) {
  const entries = Array.isArray(files) ? files : [];
  const byIndex = new Map(entries.map((entry) => [entry.index, entry]));
  /** @type {Map<string, Map<number, object>>} */
  const lists = new Map([
    ["video", new Map()],
    ["audio", new Map()],
    ["subtitles", new Map()]
  ]);
  const put = (list, fileIndex) => {
    const entry = byIndex.get(fileIndex);
    if (entry) {
      lists.get(list).set(fileIndex, entry);
    }
  };
  for (const item of Array.isArray(items) ? items : []) {
    put("video", item.fileIndex);
    for (const fileIndex of item.audio ?? []) {
      put("audio", fileIndex);
    }
    for (const fileIndex of item.subtitles ?? []) {
      put("subtitles", fileIndex);
    }
  }
  // A soundtrack or a subtitle file that belongs to no picture is still
  // offered: a viewer can choose it, and hiding it because a name matched
  // nothing would take away something the release ships.
  for (const entry of entries) {
    if (entry.kind === "audio") {
      put("audio", entry.index);
    } else if (entry.kind === "subtitle") {
      put("subtitles", entry.index);
    }
  }
  return {
    // Only the picture's list is shortened. A soundtrack and a subtitle file
    // are named by their language and their author, and those ARE what
    // distinguishes them.
    video: withDisplayNames([...lists.get("video").values()]),
    audio: [...lists.get("audio").values()],
    subtitles: [...lists.get("subtitles").values()]
  };
}

/**
 * What to show for each file, with the release's own furniture taken off.
 *
 * A release repeats itself in every name — `[HorribleSubs] Drifters - 01
 * [1080p].mkv` through `- 12 [1080p].mkv` — and the repetition is exactly the
 * part that says nothing about which episode this is. So the rule needs no list
 * of known release groups and no guess at which words are technical: a
 * BRACKETED part that is present in EVERY name of the list is the release's, not
 * this file's, and comes off. What is left is the title and the episode.
 *
 * Deliberately limited to bracketed parts. A releaser written without brackets
 * (`Drifters.01.WEBRip-GROUP`) is left alone, because the only way to find it
 * would be to strip the longest common text — and the title sits in that same
 * common text, so it would go too.
 *
 * A list of one is left alone: with nothing to compare against, every part of
 * the name is "common", and the whole name would come off.
 *
 * @template {{ relativePath?: string, path?: string, name?: string }} T
 * @param {T[]} files
 * @returns {T[]} The same entries, each with `displayName`.
 */
function withDisplayNames(files) {
  const pathOf = (file) => String(file.relativePath ?? file.path ?? file.name ?? "");
  if (files.length < 2) {
    return files.map((file) => ({ ...file, displayName: pathOf(file) }));
  }
  const bracketsIn = (text) => (text.match(/\[[^\]]*\]/g) ?? []).map((token) => token.trim());
  // Present in every name, so it describes the release rather than the file.
  const shared = bracketsIn(pathOf(files[0])).filter((token) =>
    files.every((file) => pathOf(file).includes(token))
  );
  return files.map((file) => {
    const full = pathOf(file);
    let shown = full;
    for (const token of shared) {
      shown = shown.split(token).join(" ");
    }
    shown = shown
      // The extension names the container, which is the same for every file of
      // a release and never tells a viewer which episode they are choosing.
      .replace(/\.[a-z0-9]{2,4}$/i, "")
      // Separators the removals left facing nothing.
      .replace(/\s{2,}/g, " ")
      .replace(/\s*[-–—_.]+\s*$/, "")
      .replace(/^\s*[-–—_.]+\s*/, "")
      .trim();
    // Everything was furniture, so nothing is left to identify the file by.
    // The full name says more than an empty line does.
    return { ...file, displayName: shown.length > 0 ? shown : full };
  });
}

/**
 * The proxy's file list, in the entry shape the rest of this page speaks.
 *
 * The paths arrive already relative to the torrent root — the proxy strips its
 * own name, so there is one stripping rule in the product rather than two that
 * can disagree — and what each file IS was decided there too. Nothing here
 * looks at a name.
 *
 * @param {string} baseName - The torrent's name, for the absolute path only.
 * @param {Array<{ fileIndex?: number, name?: string, relativePath?: string, length?: number, kind?: string }>} rawFiles
 * @returns {Array<{ index: number, name: string, path: string, relativePath: string, length: number, isVideo: boolean }>}
 */
export function normalizeRemoteFileList(baseName, rawFiles) {
  if (!Array.isArray(rawFiles)) {
    return [];
  }
  const multi = rawFiles.length > 1;
  return rawFiles.map((entry, position) => {
    const index = Number.isInteger(entry?.fileIndex) ? entry.fileIndex : position;
    const name = typeof entry?.name === "string" && entry.name.length > 0 ? entry.name : `file-${index}`;
    const relativePath =
      typeof entry?.relativePath === "string" && entry.relativePath.length > 0 ? entry.relativePath : name;
    return {
      index,
      name,
      path: multi && baseName ? `${baseName}/${relativePath}` : relativePath,
      relativePath,
      length: Number.isFinite(entry?.length) ? entry.length : 0,
      kind: typeof entry?.kind === "string" ? entry.kind : "other",
      isVideo: entry?.kind === "video"
    };
  });
}

async function sha1(bytes) {
  const hashBuffer = await crypto.subtle.digest("SHA-1", bytes);
  return new Uint8Array(hashBuffer);
}

export async function parseTorrentBytes(torrentBytes) {
  const rootNode = decodeBencode(torrentBytes);
  if (!rootNode || typeof rootNode !== "object" || Array.isArray(rootNode)) {
    throw new Error("Invalid torrent root node.");
  }

  const infoNode =
    rootNode.info && typeof rootNode.info === "object" && !Array.isArray(rootNode.info)
      ? rootNode.info
      : null;
  if (!infoNode) {
    throw new Error("Torrent has no info dictionary.");
  }

  const infoStart = toNumber(rootNode.__infoStart, -1);
  const infoEnd = toNumber(rootNode.__infoEnd, -1);
  if (infoStart < 0 || infoEnd <= infoStart || infoEnd > torrentBytes.length) {
    throw new Error("Could not read raw info dictionary bytes.");
  }

  const infoBytes = torrentBytes.slice(infoStart, infoEnd);
  const infoHashBytes = await sha1(infoBytes);
  const name = normalizeString(infoNode.name) || "Unnamed torrent";
  const pieceLength = toNumber(infoNode["piece length"]);
  const piecesBytes = normalizeBytes(infoNode.pieces);
  const pieceCount = Math.floor(piecesBytes.length / 20);

  const isMultiFile = Array.isArray(infoNode.files);
  const files = isMultiFile
    ? parseMultiFile(name, infoNode.files)
    : parseSingleFile(name, toNumber(infoNode.length));

  const totalSize = files.reduce((sum, file) => sum + file.length, 0);
  const announce = normalizeString(rootNode.announce);
  const announceList = Array.isArray(rootNode["announce-list"])
    ? rootNode["announce-list"]
        .flatMap((group) => (Array.isArray(group) ? group : []))
        .map((item) => normalizeString(item))
        .filter((item) => item.length > 0)
    : [];
  const webSeeds = toStringList(rootNode["url-list"]);

  return {
    name,
    infoHashHex: bytesToHex(infoHashBytes),
    pieceLength,
    pieceCount,
    totalSize,
    files,
    announce,
    announceList,
    webSeeds,
    isMultiFile
  };
}

/**
 * Whether a magnet link names any tracker of its own.
 *
 * This is the difference between two failures that look identical from the
 * outside. A magnet carrying `tr=` parameters was announced to real trackers,
 * so finding nobody means the swarm is empty or unreachable. A magnet carrying
 * none was never announced anywhere: only the distributed hash table could look
 * for the swarm, and for a swarm that lives on a tracker it finds nobody at
 * all. Saying "no peers reachable" for the second names a consequence and hides
 * the one thing the viewer can act on — the link is short, not the file dead.
 *
 * Established 2026-08-20: this app's own share links carry every tracker of the
 * original `.torrent`, and with them the same film reached 52-67 seeders where
 * a bare magnet for it reached none.
 *
 * @param {string} magnetUri
 * @returns {boolean} False when the link names no tracker, or cannot be read.
 */
export function magnetNamesATracker(magnetUri) {
  if (typeof magnetUri !== "string" || magnetUri.length === 0) {
    return false;
  }
  // A magnet is not a hierarchical URL, so its parameters are read from the
  // text after the first "?" rather than through URL's pathname handling.
  const query = magnetUri.slice(magnetUri.indexOf("?") + 1);
  if (query.length === 0 || query === magnetUri) {
    return false;
  }
  try {
    return new URLSearchParams(query).getAll("tr").some((value) => value.trim().length > 0);
  } catch {
    return false;
  }
}
