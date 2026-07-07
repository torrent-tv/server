import { bytesToHex, bytesToUtf8, decodeBencode } from "./bencode.js";

const VIDEO_EXTENSIONS = new Set([
  ".mp4",
  ".mkv",
  ".webm",
  ".mov",
  ".m4v",
  ".avi",
  ".mpg",
  ".mpeg",
  ".ts",
  ".m2ts"
]);

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

function isVideoPath(path) {
  const lower = path.toLowerCase();
  for (const ext of VIDEO_EXTENSIONS) {
    if (lower.endsWith(ext)) {
      return true;
    }
  }
  return false;
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
      length,
      isVideo: isVideoPath(relativePath)
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
      length,
      isVideo: isVideoPath(name)
    }
  ];
}

/** Same categorisation rules the torrent picker applies to parsed files. */
const AUDIO_EXTENSIONS = new Set([
  ".aac", ".ac3", ".alac", ".dts", ".eac3", ".flac", ".m4a", ".mp3", ".ogg", ".opus", ".wav"
]);
const SUBTITLE_EXTENSIONS = new Set([
  ".ass", ".srt", ".ssa", ".sub", ".sup", ".ttml", ".vtt", ".webvtt"
]);

/**
 * Group file entries into video / audio / subtitle lists (the shape the
 * player and subtitle pipeline consume).
 *
 * @param {Array<{ relativePath?: string, path?: string, isVideo?: boolean }>} files
 * @returns {{ video: Array<object>, audio: Array<object>, subtitles: Array<object> }}
 */
export function classifyMediaFiles(files) {
  const video = [];
  const audio = [];
  const subtitles = [];
  const hasExtension = (lowerPath, extensions) => {
    for (const ext of extensions) {
      if (lowerPath.endsWith(ext)) {
        return true;
      }
    }
    return false;
  };
  for (const file of Array.isArray(files) ? files : []) {
    const lowerPath = String(file.relativePath ?? file.path ?? "").toLowerCase();
    if (file.isVideo) {
      video.push(file);
      continue;
    }
    if (hasExtension(lowerPath, AUDIO_EXTENSIONS)) {
      audio.push(file);
      continue;
    }
    if (hasExtension(lowerPath, SUBTITLE_EXTENSIONS)) {
      subtitles.push(file);
    }
  }
  return { video, audio, subtitles };
}

/**
 * Normalize a proxy-reported file list (magnet metadata) into the same file
 * entries `parseTorrentBytes` produces from a `.torrent` file.
 *
 * @param {string} baseName - Torrent name (path prefix for multi-file).
 * @param {Array<{ index?: number, name?: string, relativePath?: string, length?: number }>} rawFiles
 * @returns {Array<{ index: number, name: string, path: string, relativePath: string, length: number, isVideo: boolean }>}
 */
export function normalizeRemoteFileList(baseName, rawFiles) {
  if (!Array.isArray(rawFiles)) {
    return [];
  }
  const multi = rawFiles.length > 1;
  return rawFiles.map((entry, position) => {
    const index = Number.isInteger(entry?.index) ? entry.index : position;
    const name = typeof entry?.name === "string" && entry.name.length > 0 ? entry.name : `file-${index}`;
    // WebTorrent's file.path already includes the torrent name for multi-file
    // torrents; keep relativePath relative to the torrent root like the
    // .torrent parser does.
    const reported = typeof entry?.relativePath === "string" && entry.relativePath.length > 0 ? entry.relativePath : name;
    const relativePath =
      multi && baseName && reported.startsWith(`${baseName}/`)
        ? reported.slice(baseName.length + 1)
        : reported;
    return {
      index,
      name,
      path: multi && baseName ? `${baseName}/${relativePath}` : relativePath,
      relativePath,
      length: Number.isFinite(entry?.length) ? entry.length : 0,
      isVideo: isVideoPath(relativePath)
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
