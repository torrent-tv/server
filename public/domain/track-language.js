/** Common ISO 639-2 (ffmpeg language tags) to 639-1 codes. */
const ISO639_2_TO_1 = {
  eng: "en", rus: "ru", jpn: "ja", kor: "ko", spa: "es", pol: "pl",
  deu: "de", ger: "de", fra: "fr", fre: "fr", ita: "it", por: "pt",
  ukr: "uk", zho: "zh", chi: "zh", ara: "ar", hin: "hi", tur: "tr",
  nld: "nl", dut: "nl", swe: "sv", ces: "cs", cze: "cs"
};

const LANGUAGE_DISPLAY =
  typeof Intl !== "undefined" && "DisplayNames" in Intl
    ? new Intl.DisplayNames(["en"], { type: "language" })
    : null;

/** @param {{ language?: string, languageBcp47?: string }} track */
export function trackLanguageTag(track) {
  const tag = typeof track?.languageBcp47 === "string" ? track.languageBcp47.trim() : "";
  return tag.length > 0 ? tag : (track?.language ?? "");
}

/** @param {string} language */
export function trackLanguageCode(language) {
  const lang = typeof language === "string" ? language.toLowerCase() : "";
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
    return "";
  }
}
