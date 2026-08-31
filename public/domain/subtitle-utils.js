/**
 * @file Subtitle utilities.
 *
 * - Match external subtitle files in a torrent to a specific video file.
 * - Detect subtitle language (ISO 639-1 code + display name) and release group
 *   from directory names and filename suffixes.
 * - Convert SRT / ASS / SSA subtitle text to WebVTT so it can be fed to a
 *   `<track>` element.
 */

// ---------------------------------------------------------------------------
// Language lookup table
// Keys: ISO 639-1 (2-letter), ISO 639-2/T (3-letter), common English names.
// Values: { code: BCP-47 / ISO 639-1, name: English display name }
// ---------------------------------------------------------------------------

/** @type {Record<string, { code: string, name: string }>} */
const LANG_MAP = {
  // English
  en: { code: "en", name: "English" }, eng: { code: "en", name: "English" }, english: { code: "en", name: "English" },
  // Russian
  ru: { code: "ru", name: "Russian" }, rus: { code: "ru", name: "Russian" }, russian: { code: "ru", name: "Russian" },
  // Japanese
  ja: { code: "ja", name: "Japanese" }, jpn: { code: "ja", name: "Japanese" }, japanese: { code: "ja", name: "Japanese" },
  // Korean
  ko: { code: "ko", name: "Korean" }, kor: { code: "ko", name: "Korean" }, korean: { code: "ko", name: "Korean" },
  // Chinese (generic)
  zh: { code: "zh", name: "Chinese" }, chi: { code: "zh", name: "Chinese" }, zho: { code: "zh", name: "Chinese" }, chinese: { code: "zh", name: "Chinese" },
  // Simplified / Traditional
  chs: { code: "zh-Hans", name: "Chinese (Simplified)" }, cht: { code: "zh-Hant", name: "Chinese (Traditional)" },
  // Spanish
  es: { code: "es", name: "Spanish" }, spa: { code: "es", name: "Spanish" }, spanish: { code: "es", name: "Spanish" },
  // French
  fr: { code: "fr", name: "French" }, fre: { code: "fr", name: "French" }, fra: { code: "fr", name: "French" }, french: { code: "fr", name: "French" },
  // German
  de: { code: "de", name: "German" }, ger: { code: "de", name: "German" }, deu: { code: "de", name: "German" }, german: { code: "de", name: "German" },
  // Italian
  it: { code: "it", name: "Italian" }, ita: { code: "it", name: "Italian" }, italian: { code: "it", name: "Italian" },
  // Portuguese
  pt: { code: "pt", name: "Portuguese" }, por: { code: "pt", name: "Portuguese" }, portuguese: { code: "pt", name: "Portuguese" },
  // Polish
  pl: { code: "pl", name: "Polish" }, pol: { code: "pl", name: "Polish" }, polish: { code: "pl", name: "Polish" },
  // Dutch
  nl: { code: "nl", name: "Dutch" }, nld: { code: "nl", name: "Dutch" }, dut: { code: "nl", name: "Dutch" }, dutch: { code: "nl", name: "Dutch" },
  // Arabic
  ar: { code: "ar", name: "Arabic" }, ara: { code: "ar", name: "Arabic" }, arabic: { code: "ar", name: "Arabic" },
  // Turkish
  tr: { code: "tr", name: "Turkish" }, tur: { code: "tr", name: "Turkish" }, turkish: { code: "tr", name: "Turkish" },
  // Vietnamese
  vi: { code: "vi", name: "Vietnamese" }, vie: { code: "vi", name: "Vietnamese" }, vietnamese: { code: "vi", name: "Vietnamese" },
  // Thai
  th: { code: "th", name: "Thai" }, tha: { code: "th", name: "Thai" }, thai: { code: "th", name: "Thai" },
  // Hindi
  hi: { code: "hi", name: "Hindi" }, hin: { code: "hi", name: "Hindi" }, hindi: { code: "hi", name: "Hindi" },
  // Indonesian
  id: { code: "id", name: "Indonesian" }, ind: { code: "id", name: "Indonesian" }, indonesian: { code: "id", name: "Indonesian" },
  // Malay
  ms: { code: "ms", name: "Malay" }, may: { code: "ms", name: "Malay" }, msa: { code: "ms", name: "Malay" }, malay: { code: "ms", name: "Malay" },
  // Ukrainian
  uk: { code: "uk", name: "Ukrainian" }, ukr: { code: "uk", name: "Ukrainian" }, ukrainian: { code: "uk", name: "Ukrainian" },
  // Czech
  cs: { code: "cs", name: "Czech" }, cze: { code: "cs", name: "Czech" }, ces: { code: "cs", name: "Czech" }, czech: { code: "cs", name: "Czech" },
  // Slovak
  sk: { code: "sk", name: "Slovak" }, slo: { code: "sk", name: "Slovak" }, slk: { code: "sk", name: "Slovak" }, slovak: { code: "sk", name: "Slovak" },
  // Romanian
  ro: { code: "ro", name: "Romanian" }, rum: { code: "ro", name: "Romanian" }, ron: { code: "ro", name: "Romanian" }, romanian: { code: "ro", name: "Romanian" },
  // Hungarian
  hu: { code: "hu", name: "Hungarian" }, hun: { code: "hu", name: "Hungarian" }, hungarian: { code: "hu", name: "Hungarian" },
  // Serbian
  sr: { code: "sr", name: "Serbian" }, srp: { code: "sr", name: "Serbian" }, serbian: { code: "sr", name: "Serbian" },
  // Croatian
  hr: { code: "hr", name: "Croatian" }, hrv: { code: "hr", name: "Croatian" }, croatian: { code: "hr", name: "Croatian" },
  // Bulgarian
  bg: { code: "bg", name: "Bulgarian" }, bul: { code: "bg", name: "Bulgarian" }, bulgarian: { code: "bg", name: "Bulgarian" },
  // Greek
  el: { code: "el", name: "Greek" }, gre: { code: "el", name: "Greek" }, ell: { code: "el", name: "Greek" }, greek: { code: "el", name: "Greek" },
  // Hebrew
  he: { code: "he", name: "Hebrew" }, heb: { code: "he", name: "Hebrew" }, hebrew: { code: "he", name: "Hebrew" },
  // Danish
  da: { code: "da", name: "Danish" }, dan: { code: "da", name: "Danish" }, danish: { code: "da", name: "Danish" },
  // Finnish
  fi: { code: "fi", name: "Finnish" }, fin: { code: "fi", name: "Finnish" }, finnish: { code: "fi", name: "Finnish" },
  // Norwegian
  no: { code: "no", name: "Norwegian" }, nor: { code: "no", name: "Norwegian" }, norwegian: { code: "no", name: "Norwegian" },
  // Swedish
  sv: { code: "sv", name: "Swedish" }, swe: { code: "sv", name: "Swedish" }, swedish: { code: "sv", name: "Swedish" }
};

// ---------------------------------------------------------------------------
// Subtitle info detection
// ---------------------------------------------------------------------------

/**
 * @typedef {{ code: string, name: string, group: string | null }} SubtitleInfo
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
 * Look up language info from a raw token (e.g. `"rus"`, `"ENG"`, `"polish"`).
 *
 * @param {string} token
 * @returns {{ code: string, name: string } | null}
 */
function lookupLang(token) {
  return LANG_MAP[token.toLowerCase()] ?? null;
}

/**
 * Detect the language and optional release-group name for a subtitle file.
 *
 * Detection order:
 * 1. Directory component of `relativePath` (e.g. `ENG/`, `RUS/`).
 * 2. Suffix in the filename after the last `]` bracket, split by `_`
 *    (e.g. `_rus_AT_Team` → lang `ru`, group `AT Team`).
 * 3. Parts from the end of the base filename, split by `_`.
 *
 * @param {{ name: string, path?: string, relativePath?: string }} subtitleFile
 * @param {{ name?: string }} [videoFile] - The picture these subtitles belong
 *   to. Its name is what tells a bracketed group that names the RELEASE apart
 *   from one that names the translator: only a bracket the video does not also
 *   carry can be the author of a file beside it.
 * @returns {SubtitleInfo}
 */
export function detectSubtitleInfo(subtitleFile, videoFile = null) {
  const videoName = typeof videoFile?.name === "string" ? videoFile.name : "";
  const relPath =
    (typeof subtitleFile.relativePath === "string" ? subtitleFile.relativePath : null) ??
    (typeof subtitleFile.path === "string" ? subtitleFile.path : null) ??
    subtitleFile.name;

  // Directory segments (everything before the filename).
  const segments = relPath.replace(/\\/g, "/").split("/");
  const dirSegments = segments.slice(0, -1);
  const fileName = segments[segments.length - 1] ?? subtitleFile.name;
  const baseName = stripExtension(fileName);

  // 1. Try to find a language code in the directory hierarchy (innermost first).
  //    Whole segment first (`ENG/`), then its words — the second reads a folder
  //    like `Rus Sub/`, which the whole-segment lookup alone could not.
  const fromFolders = languageFromFolders(dirSegments);
  let langCode = fromFolders?.code ?? null;
  let langName = fromFolders?.name ?? null;

  // 2. Extract the suffix after the last `]` in the base name.
  //    e.g. "[_GROUP_]_EP01_[78EFD746]_rus_AT_Team" → suffix "_rus_AT_Team"
  const lastBracket = baseName.lastIndexOf("]");
  const suffix = lastBracket >= 0 ? baseName.slice(lastBracket + 1) : "";
  const suffixParts = suffix
    .split("_")
    .map((p) => p.trim())
    .filter((p) => p.length > 0);

  let langFromSuffix = null;
  let langIdxInSuffix = -1;
  for (let i = 0; i < suffixParts.length; i++) {
    const info = lookupLang(suffixParts[i]);
    if (info) {
      langFromSuffix = info;
      langIdxInSuffix = i;
      break;
    }
  }

  if (!langCode && langFromSuffix) {
    langCode = langFromSuffix.code;
    langName = langFromSuffix.name;
  }

  // Group name: suffix parts after the language token.
  let group = null;
  if (langIdxInSuffix >= 0 && langIdxInSuffix < suffixParts.length - 1) {
    group = suffixParts.slice(langIdxInSuffix + 1).join(" ") || null;
  }

  // 3. Fallback: scan underscore-parts of the full base name from the end
  //    (for files without bracket tokens).
  if (!langCode && lastBracket < 0) {
    const parts = baseName.split("_");
    for (let i = parts.length - 1; i >= 0; i--) {
      const info = lookupLang(parts[i]);
      if (info) {
        langCode = info.code;
        langName = info.name;
        // Parts after the language token are the group.
        const groupParts = parts.slice(i + 1).filter((p) => p.length > 0);
        group = groupParts.length > 0 ? groupParts.join(" ") : null;
        break;
      }
    }
  }

  // 4. The team, where the suffix rule found none: a bracketed group in the
  //    innermost folder or in the file name that the VIDEO does not also carry.
  //    That last condition is what stops the picture's own release group being
  //    reported as the author of somebody else's translation.
  if (!group) {
    group = releaserFrom({ folders: dirSegments, fileName, videoName });
  }

  return {
    code: langCode ?? "und",
    name: langName ?? "Unknown",
    group: group ?? null
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
  // A bracket that names a language names a language, not a team.
  return lookupLang(text) !== null;
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
 * A whole segment is tried first (`ENG`, `Russian`), then its words — which is
 * what reads `Rus Sound` as Russian. A word is only accepted from a multi-word
 * segment when it is at least three letters, because two-letter codes are also
 * ordinary words (`no`, `id`, `it`) and a folder called `No Subs` does not mean
 * Norwegian.
 *
 * @param {string[]} folders
 * @returns {{ code: string, name: string } | null}
 */
export function languageFromFolders(folders) {
  const segments = Array.isArray(folders) ? folders : [];
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    const segment = String(segments[index] ?? "");
    const whole = lookupLang(segment.trim());
    if (whole) {
      return whole;
    }
    const words = segment.split(/[^\p{L}]+/u).filter((word) => word.length >= 3);
    for (const word of words) {
      const found = lookupLang(word);
      if (found) {
        return found;
      }
    }
  }
  return null;
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
 * Language and releaser for a track that ships as its own file.
 *
 * @param {object} params
 * @param {string[]} params.folders
 * @param {string} params.fileName
 * @param {string} [params.videoName]
 * @returns {{ code: string | null, name: string | null, releaser: string | null }}
 */
export function sidecarNaming({ folders, fileName, videoName = "" }) {
  const language = languageFromFolders(folders);
  return {
    code: language?.code ?? null,
    name: language?.name ?? null,
    releaser: releaserFrom({ folders, fileName, videoName })
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
