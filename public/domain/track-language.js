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

  let code = OPEN_SUBTITLES_LANGUAGE_ALIASES[providerCode] ?? raw;
  const [base, ...variants] = code.toLowerCase().split("-");
  const normalizedBase = base.length === 3 ? ISO639_2_TO_1[base] ?? base : base;
  code = [normalizedBase, ...variants].join("-");
  try {
    code = Intl.getCanonicalLocales(code)[0] ?? code;
  } catch {
    // silent-ok: Preserve unsupported tags rather than guessing their language.
  }
  const unknown = !code || code.toLowerCase() === "und";
  let name = "";
  try {
    name = LANGUAGE_DISPLAY?.of(code) ?? "";
  } catch {
    // silent-ok: Keep the supplied tag when it has no display name.
  }
  if (code.toLowerCase() === "yue") name = "Chinese (Cantonese)";
  return { code: unknown ? "und" : code, name: unknown ? "Unknown language" : name || raw || code, unknown };
}
