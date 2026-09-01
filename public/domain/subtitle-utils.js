/**
 * @file Subtitle utilities.
 *
 * - Match external subtitle files in a torrent to a specific video file.
 * - Detect subtitle language (ISO 639-1 code + display name) and release group
 *   from directory names and filename suffixes.
 * - Convert SRT / ASS / SSA subtitle text to WebVTT so it can be fed to a
 *   `<track>` element.
 */

import {
  isNeutralWord,
  languageFromFolderNames,
  lookupLanguage,
  readSidecarName
} from "./track-naming.js";

// ---------------------------------------------------------------------------
// The language table, the flag words and the name grammar live in
// `track-naming.js`, because they are the same question for a soundtrack as for
// a subtitle and the grammar is sourced from five other players. See that file.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Subtitle info detection
// ---------------------------------------------------------------------------

/**
 * @typedef {{ code: string, name: string, group: string | null,
 *   isForced?: boolean, isHearingImpaired?: boolean, isDefault?: boolean }} SubtitleInfo
 */

/**
 * Extract all uppercase/hex bracket tokens from a filename, e.g. `[78EFD746]`.
 * Used for matching subtitle files to video files by a shared release hash.
 *
 * @param {string} name - Filename without extension.
 * @returns {string[]} Lowercase hex strings found inside `[…]`.
 */
function extractHexTokens(name) {
  const tokens = [];
  for (const m of name.matchAll(/\[([0-9A-F]{4,10})\]/gi)) {
    tokens.push(m[1].toLowerCase());
  }
  return tokens;
}

/**
 * Remove the file extension from a name.
 *
 * @param {string} name
 * @returns {string}
 */
function stripExtension(name) {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
}

/**
 * What is left of a name after the language and the flags, as a TITLE — or
 * nothing, when what is left only describes the encode.
 *
 * Jellyfin keeps every leftover word ("Any arbitrary text not parsable to a
 * language or flag will be combined and used as the title of the stream"), and
 * on its own library that is right, because the part it reads is what the owner
 * deliberately appended. A torrent is not that tidy: `Film.1080p.rus.srt` beside
 * `Film.mkv` leaves `1080p`, and a track labelled "Russian (1080p)" is worse
 * than one labelled "Russian". The same list that keeps a resolution from being
 * read as a release group keeps it from being read as a title.
 *
 * @param {string | null} title
 * @returns {string | null}
 */
function titleOf(title) {
  if (typeof title !== "string") {
    return null;
  }
  const words = title.split(/\s+/).filter((word) => word.length > 0);
  if (words.length === 0) {
    return null;
  }
  // ALL of it, or none. A word is only weighed on its own when it stands on its
  // own: inside a phrase, a word that happens to name a language is part of the
  // phrase — `English Commentary` is a title, and dropping `English` from it
  // would leave a label nobody wrote.
  return words.every((word) => isTechnicalToken(word)) ? null : words.join(" ");
}

/**
 * Detect the language, the flags and the optional release-group name a subtitle
 * file's own path states.
 *
 * Reading order, and the reason for it: the FILE NAME first, then the folders.
 * All five players surveyed read the name (`research/sidecar-naming-conventions-
 * 2026-09-01.md`); only VLC and Kodi treat a folder as a place rather than as a
 * statement about language. A name is also per-file, where a folder is per-group,
 * so where both speak the name is the more specific of the two. The grammar
 * itself is in `track-naming.js`.
 *
 * @param {{ name: string, path?: string, relativePath?: string }} subtitleFile
 * @param {{ name?: string }} [videoFile] - The picture these subtitles belong
 *   to. Its name does two things: it marks where the film's own name ends and
 *   the track's description begins, and it tells a bracketed group that names
 *   the RELEASE apart from one that names the translator — only a bracket the
 *   video does not also carry can be the author of a file beside it.
 * @returns {SubtitleInfo}
 */
export function detectSubtitleInfo(subtitleFile, videoFile = null) {
  const videoName = typeof videoFile?.name === "string" ? videoFile.name : "";
  const relPath =
    (typeof subtitleFile.relativePath === "string" ? subtitleFile.relativePath : null) ??
    (typeof subtitleFile.path === "string" ? subtitleFile.path : null) ??
    subtitleFile.name;

  // Directory segments (everything before the filename).
  const segments = relPath.split(/[\\/]/);
  const dirSegments = segments.slice(0, -1);
  const fileName = segments[segments.length - 1] ?? subtitleFile.name;
  const baseName = stripExtension(fileName);

  const fromName = readSidecarName(baseName, stripExtension(videoName));
  const fromFolders = fromName.language ? null : languageFromFolders(dirSegments);
  const language = fromName.language ?? fromFolders;

  // The team: what the name left over, else a bracketed group in the innermost
  // folder or in the file name that the VIDEO does not also carry.
  const group = titleOf(fromName.title) ?? releaserFrom({ folders: dirSegments, fileName, videoName });

  return {
    code: language?.code ?? "und",
    name: language?.name ?? "Unknown",
    group: group ?? null,
    isForced: fromName.isForced,
    isHearingImpaired: fromName.isHearingImpaired,
    isDefault: fromName.isDefault
  };
}

// ---------------------------------------------------------------------------
// What a torrent's own names say about a track shipped as a file beside the
// video: which language it is in, and who made it.
//
// Used for BOTH soundtracks and subtitles, because both are the same question
// about the same kind of path. A release states these two things in the two
// places it has: a folder that names a language (`Rus Sound/`, `ENG/`) and a
// bracketed group that names a team (`[Stan WarHammer & Nesitach]/`).
// ---------------------------------------------------------------------------

/**
 * Bracketed groups that describe the ENCODE rather than a team — resolution,
 * codec, source, audio format, bit depth. A releaser's name is what is left
 * after these are set aside.
 *
 * @param {string} token
 * @returns {boolean}
 */
function isTechnicalToken(token) {
  const text = token.trim().toLowerCase();
  if (text.length === 0) {
    return true;
  }
  // A release hash: `[78EFD746]`. It identifies the file, not its author.
  if (/^[0-9a-f]{4,10}$/.test(text) && /\d/.test(text)) {
    return true;
  }
  if (/^\d{3,4}[pi]$/.test(text) || /^\d{3,4}x\d{3,4}$/.test(text)) {
    return true;
  }
  if (/^(x|h)\.?26[45]$/.test(text) || /^(hevc|avc|av1|vp9|xvid|divx)$/.test(text)) {
    return true;
  }
  if (/^(aac|ac3|eac3|dts(-?hd)?|flac|mp3|opus|truehd|atmos|pcm|\d\.\d)$/.test(text)) {
    return true;
  }
  if (/^(web-?rip|web-?dl|bd-?rip|blu-?ray|hdtv|dvd-?rip|remux|hdr\d*|dv|sdr|\d{1,2}bit)$/.test(text)) {
    return true;
  }
  // A bracket that names a language names a language, not a team; and one that
  // names the KIND of track (`[Subs]`) names neither.
  return lookupLanguage(text) !== null || isNeutralWord(text);
}

/**
 * The bracketed groups of a name, in order.
 *
 * @param {string} text
 * @returns {string[]}
 */
function bracketTokens(text) {
  const source = typeof text === "string" ? text : "";
  const tokens = [];
  for (const match of source.matchAll(/\[([^\]]+)\]/g)) {
    const token = match[1].trim();
    if (token.length > 0) {
      tokens.push(token);
    }
  }
  return tokens;
}

/**
 * The language a path states, looking at the folders from the innermost out.
 *
 * Kept as this module's name for it; the rule itself is `languageFromFolderNames`
 * in `track-naming.js`, shared with soundtracks.
 *
 * @param {string[]} folders
 * @returns {{ code: string, name: string } | null}
 */
export function languageFromFolders(folders) {
  return languageFromFolderNames(folders);
}

/**
 * Who made a track that ships as its own file, when the torrent says so.
 *
 * The rule that keeps this honest: a bracketed group is only a releaser of the
 * SIDECAR when it is not also in the video's own name. In the field case that
 * settles it — a Russian dub named exactly like the picture,
 * `[HorribleSubs] Drifters - 02 [1080p].mka`, sitting in `Rus Sound/` — every
 * bracket it carries is the picture's, and attributing the dub to HorribleSubs
 * would be inventing an author. The subtitles of the same release, in
 * `Sub/[Stan WarHammer & Nesitach]/`, carry a bracket the video does not, and
 * that one IS their author.
 *
 * The innermost folder is looked at before the file name, because that is where
 * a release puts the team when several of them contributed.
 *
 * @param {object} params
 * @param {string[]} params.folders - Folders above the file, innermost last.
 * @param {string} params.fileName
 * @param {string} [params.videoName] - The picture's own file name.
 * @returns {string | null}
 */
export function releaserFrom({ folders, fileName, videoName = "" }) {
  const shared = new Set(
    bracketTokens(stripExtension(String(videoName ?? ""))).map((token) => token.toLowerCase())
  );
  const sources = [...(Array.isArray(folders) ? folders : [])].reverse();
  sources.push(stripExtension(String(fileName ?? "")));
  for (const source of sources) {
    for (const token of bracketTokens(source)) {
      if (shared.has(token.toLowerCase()) || isTechnicalToken(token)) {
        continue;
      }
      return token;
    }
  }
  return null;
}

/**
 * Language, flags and releaser for a track that ships as its own file.
 *
 * The same reading order as `detectSubtitleInfo`: the file name first, the
 * folders second. A soundtrack is named by the same conventions a subtitle is —
 * Jellyfin's own example set carries `Film.en.ac3` and `Film.german.ac3` beside
 * `Film.de.srt` — so it is the same grammar, applied to the same path.
 *
 * @param {object} params
 * @param {string[]} params.folders
 * @param {string} params.fileName
 * @param {string} [params.videoName]
 * @returns {{ code: string | null, name: string | null, releaser: string | null,
 *   isForced: boolean, isHearingImpaired: boolean, isDefault: boolean }}
 */
export function sidecarNaming({ folders, fileName, videoName = "" }) {
  const fromName = readSidecarName(
    stripExtension(String(fileName ?? "")),
    stripExtension(String(videoName ?? ""))
  );
  const language = fromName.language ?? languageFromFolders(folders);
  return {
    code: language?.code ?? null,
    name: language?.name ?? null,
    releaser: titleOf(fromName.title) ?? releaserFrom({ folders, fileName, videoName }),
    isForced: fromName.isForced,
    isHearingImpaired: fromName.isHearingImpaired,
    isDefault: fromName.isDefault
  };
}

/**
 * Build the display label for a subtitle track.
 *
 * What a track IS comes from the container's own flags, not from the words a
 * releaser typed into its name. Two of them change what a viewer should expect
 * and are therefore shown (RFC 9559 §5.1.4.1):
 *
 * - **forced** (`FlagForced`) — the track carries what is needed even when
 *   subtitles were not asked for: signs, and speech in another language. It
 *   does NOT carry the film's dialogue, so a viewer choosing it should know
 *   they will see a line every few minutes rather than a conversation;
 * - **SDH** (`FlagHearingImpaired`) — "suitable for users with hearing
 *   impairments", so it carries non-speech sound as well as speech.
 *
 * The releaser's own name is still shown in brackets beside them, because it
 * often says something the flags cannot — which studio dubbed it, which team
 * translated it.
 *
 * @param {SubtitleInfo & { isForced?: boolean, isHearingImpaired?: boolean }} info
 * @returns {string} e.g. `"Russian"`, `"Russian (AT Team)"`,
 *   `"Russian (fors) · forced"`, `"English · SDH"`
 */
export function buildSubtitleLabel(info) {
  const base = info.group ? `${info.name} (${info.group})` : info.name;
  const marks = [];
  if (info.isForced === true) {
    marks.push("forced");
  }
  if (info.isHearingImpaired === true) {
    marks.push("SDH");
  }
  return marks.length > 0 ? `${base} · ${marks.join(" · ")}` : base;
}

// ---------------------------------------------------------------------------
// Video ↔ subtitle file matching
// ---------------------------------------------------------------------------

/**
 * Find all subtitle files in `subtitleFiles` that belong to `videoFile`.
 *
 * Matching strategy (in order):
 * 1. Shared hex bracket token — e.g. `[78EFD746]` present in both names.
 * 2. Subtitle base name (after stripping a trailing language suffix) starts
 *    with the video base name, or equals it exactly.
 *
 * @param {{ name: string, path?: string, relativePath?: string }} videoFile
 * @param {Array<{ index: number, name: string, path?: string, relativePath?: string }>} subtitleFiles
 * @returns {Array<{ index: number, name: string, path?: string, relativePath?: string }>}
 */
export function matchSubtitlesForVideo(videoFile, subtitleFiles) {
  if (!subtitleFiles.length) {
    return [];
  }

  const videoBase = stripExtension(videoFile.name);
  const videoTokens = new Set(extractHexTokens(videoBase));
  const videoBaseLower = videoBase.toLowerCase();

  const result = [];
  for (const sub of subtitleFiles) {
    const subBase = stripExtension(sub.name);
    const subTokens = extractHexTokens(subBase);

    // Strategy 1: shared hex token.
    if (videoTokens.size > 0 && subTokens.some((t) => videoTokens.has(t))) {
      result.push(sub);
      continue;
    }

    // Strategy 2: base-name prefix match (strip language suffix from sub).
    const subBaseLower = subBase.toLowerCase();
    // Remove everything after the last "]" to get the raw base without lang suffix.
    const lastBracket = subBaseLower.lastIndexOf("]");
    const subBaseCore = lastBracket >= 0 ? subBaseLower.slice(0, lastBracket + 1) : subBaseLower;

    if (
      subBaseLower === videoBaseLower ||
      subBaseCore === videoBaseLower ||
      subBaseLower.startsWith(videoBaseLower)
    ) {
      result.push(sub);
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Subtitle format conversion → WebVTT
// ---------------------------------------------------------------------------







/**
 * Which embedded subtitle track the CONTAINER asks to be shown, if it asks for
 * one at all.
 *
 * The rule (stated by the user 2026-08-20): the container decides, and if it
 * says nothing, nothing is shown. A viewer who wants subtitles picks them in
 * the menu.
 *
 * "Says nothing" is the subtle half, and which half of it applies depends on
 * how well the file could be read.
 *
 * When the proxy managed to read the container itself, each track carries
 * `declaresDefault` — whether `FlagDefault` was WRITTEN for it. Then the answer
 * is exact: among the tracks the file actually wrote a flag for, one marked
 * means show that one; none marked, or several, means the file did not choose.
 * A single track counts here, because a flag written for one track of one is
 * still somebody saying so.
 *
 * When it could not — a container we do not parse, or a reading that did not
 * line up with the probe — every track arrives with `declaresDefault: false`
 * and only ffmpeg's banner is left, which cannot tell an unwritten flag from a
 * written one: Matroska's `FlagDefault` defaults to 1 and ffmpeg has already
 * applied that default by the time it prints, so a file that marked nothing
 * looks exactly like one that marked everything. The strongest thing the banner
 * supports is then kept: several tracks with exactly one marked is a choice,
 * and anything else is not.
 *
 * Subtitle FILES lying beside the video are not considered here at all: a file
 * in the torrent is not the container speaking about itself.
 *
 * @param {Array<{ index: number, textBased?: boolean, isDefault?: boolean, declaresDefault?: boolean }>} tracks
 * @returns {number | null} The `index` of the track to show, or null for none.
 */
export function containerDefaultSubtitleIndex(tracks) {
  const textBased = (Array.isArray(tracks) ? tracks : []).filter((t) => t?.textBased === true);
  if (textBased.length === 0) {
    return null;
  }
  const written = textBased.filter((t) => t.declaresDefault === true);
  if (written.length > 0) {
    const marked = written.filter((t) => t.isDefault === true);
    return marked.length === 1 ? marked[0].index : null;
  }
  if (textBased.length < 2) {
    return null;
  }
  const marked = textBased.filter((t) => t.isDefault === true);
  return marked.length === 1 ? marked[0].index : null;
}
