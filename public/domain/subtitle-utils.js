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
 * @returns {SubtitleInfo}
 */
export function detectSubtitleInfo(subtitleFile) {
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
  let langCode = null;
  let langName = null;
  for (let i = dirSegments.length - 1; i >= 0; i--) {
    const info = lookupLang(dirSegments[i]);
    if (info) {
      langCode = info.code;
      langName = info.name;
      break;
    }
  }

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

  return {
    code: langCode ?? "und",
    name: langName ?? "Unknown",
    group: group ?? null
  };
}

/**
 * Build the display label for a subtitle track.
 *
 * @param {SubtitleInfo} info
 * @returns {string} e.g. `"Russian"`, `"Russian (AT Team)"`
 */
export function buildSubtitleLabel(info) {
  if (info.group) {
    return `${info.name} (${info.group})`;
  }
  return info.name;
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






