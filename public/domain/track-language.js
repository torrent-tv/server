/** Common ISO 639-2 (ffmpeg language tags) to 639-1 codes. */
const ISO639_2_TO_1 = {
  eng: "en", rus: "ru", jpn: "ja", kor: "ko", spa: "es", pol: "pl",
  deu: "de", ger: "de", fra: "fr", fre: "fr", ita: "it", por: "pt",
  ukr: "uk", zho: "zh", chi: "zh", ara: "ar", hin: "hi", tur: "tr",
  nld: "nl", dut: "nl", swe: "sv", ces: "cs", cze: "cs"
};

const LANGUAGE_DISPLAY =
  typeof Intl !== "undefined" && "DisplayNames" in Intl
    ? new Intl.DisplayNames(["en"], { type: "language", languageDisplay: "standard" })
    : null;

const OPEN_SUBTITLES_LANGUAGE_ALIASES = {
  ea: "es-419", sp: "es-ES", pm: "pt-MZ",
  "zh-cn": "zh-Hans", "zh-tw": "zh-Hant", "zh-ca": "yue",
  at: "ast", ex: "ext", ma: "mni", sx: "sat", sy: "syr", tp: "tok", "tm-td": "tet"
};

const OPEN_SUBTITLES_LANGUAGE_NAMES = {
  ze: "Chinese (Bilingual)", me: "Montenegrin", pr: "Dari", "az-zb": "South Azerbaijani"
};

/** @param {{ language?: string, languageBcp47?: string }} track */
export function trackLanguageTag(track) {
  const tag = typeof track?.languageBcp47 === "string" ? track.languageBcp47.trim() : "";
  return tag.length > 0 ? tag : (track?.language ?? "");
}

/** @param {string} language */
export function trackLanguageCode(language) {
  const lang = typeof language === "string" ? language.trim().toLowerCase().split(/[-_]/u)[0] : "";
  if (lang.length === 2) {
    return lang;
  }
  return ISO639_2_TO_1[lang] ?? lang;
}

/**
 * Resolve the displayed language and title from track metadata. A title may
 * supply a language only when the track metadata does not.
 *
 * @param {{ language?: string, languageBcp47?: string, title?: string, naming?: { code?: string | null } }} track
 * @returns {{ code: string, name: string, title: string, rawTitle: string, unknown: boolean }}
 */
export function mediaTrackLanguageInfo(track, { provider = "" } = {}) {
  const rawTitle = typeof track?.title === "string" ? track.title.trim() : "";
  const explicit = trackLanguageTag(track).trim();
  let language = explicit && explicit.toLowerCase() !== "und" ? subtitleLanguageInfo(explicit, provider) : null;
  let code = language?.unknown ? "" : language?.code ?? "";
  let title = rawTitle;
  const titleLanguage = languageTokenInTitle(rawTitle);

  if (!code) {
    if (titleLanguage) {
      language = subtitleLanguageInfo(titleLanguage.code, provider);
      if (!language.unknown) {
        code = language.code;
        title = removeLanguageToken(rawTitle, titleLanguage.token);
      }
    }
  }
  if (code && titleLanguage && trackLanguageCode(titleLanguage.code) === trackLanguageCode(code)) {
    title = removeLanguageToken(rawTitle, titleLanguage.token);
  }
  if (!code && typeof track?.naming?.code === "string") {
    language = subtitleLanguageInfo(track.naming.code, provider);
    if (!language.unknown) code = language.code;
  }
  if (!code) code = "und";

  const unknown = code === "und";
  return {
    code,
    name: unknown ? "Unknown language" : language?.name || displayLanguageName(code),
    title,
    rawTitle,
    unknown
  };
}

function canonicalTrackLanguage(value) {
  const raw = String(value ?? "").trim().replaceAll("_", "-");
  if (!raw || raw.toLowerCase() === "und") return "";
  const [base, ...variants] = raw.toLowerCase().split("-");
  const normalizedBase = base.length === 3 ? ISO639_2_TO_1[base] ?? base : base;
  const normalized = [normalizedBase, ...variants].join("-");
  try {
    return Intl.getCanonicalLocales(normalized)[0] ?? "";
  } catch {
    // silent-ok: Invalid tags have no canonical language to use.
    return "";
  }
}

function languageTokenInTitle(title) {
  if (!title) return null;
  const match = title.match(/(?:^|[\s([|·—_-])([a-z]{3}(?:-[a-z]{2,4})?)(?=$|[\s)\]|·—_-])/iu);
  if (!match) return null;
  const token = match[1].toLowerCase();
  const code = canonicalTrackLanguage(token);
  if (!code || code === "und" || code === token && token.length === 3) return null;
  return { code, token: match[1] };
}

function removeLanguageToken(title, token) {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return title
    .replace(new RegExp(`(^|[\\s([|·—_-])${escaped}(?=$|[\\s)\\]|·—_-])`, "iu"), " ")
    .replace(/^[\s()[\]]+|[\s()[\]]+$/gu, "")
    .replace(/^[\s|·—_-]+|[\s|·—_-]+$/gu, "")
    .replace(/\(\s*\)|\[\s*\]/gu, "")
    .trim();
}

function displayLanguageName(code) {
  try {
    return LANGUAGE_DISPLAY?.of(code) || code;
  } catch {
    // silent-ok: Preserve the code when Intl has no display name for it.
    return code;
  }
}

/** @param {string} code @returns {string} */
export function languageName(code) {
  if (!code) {
    return "";
  }
  try {
    return LANGUAGE_DISPLAY?.of(code) ?? "";
  } catch {
    // silent-ok: an invalid language code has no display name to show.
    return "";
  }
}

/** @param {string} language @param {string} [provider] */
export function subtitleLanguageInfo(language, provider = "") {
  const raw = typeof language === "string" ? language.trim().replaceAll("_", "-") : "";
  const providerCode = provider.toLowerCase() === "opensubtitles" ? raw.toLowerCase() : "";
  const explicitName = OPEN_SUBTITLES_LANGUAGE_NAMES[providerCode];
  if (explicitName) return { code: `opensubtitles:${providerCode}`, name: explicitName, unknown: false };

  const supplied = OPEN_SUBTITLES_LANGUAGE_ALIASES[providerCode] ?? raw;
  const code = canonicalTrackLanguage(supplied) || supplied;
  const unknown = !code || code.toLowerCase() === "und";
  let name = unknown ? "" : displayLanguageName(code);
  if (code.toLowerCase() === "yue") name = "Chinese (Cantonese)";
  return { code: unknown ? "und" : code, name: unknown ? "Unknown language" : name || raw || code, unknown };
}
