import { normalizeTitle } from "./title.js";

const LETTERS = {
  а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "(?:yo|jo|e)",
  ж: "(?:zh|j)", з: "z", и: "i", й: "(?:y|i|j)", к: "k", л: "l", м: "m",
  н: "n", о: "o", п: "p", р: "r", с: "s", т: "t", у: "u", ф: "f",
  х: "(?:kh|h)", ц: "(?:ts|c)", ч: "ch", ш: "sh", щ: "(?:shch|sch)",
  ъ: "", ы: "(?:y|i)", ь: "", э: "e", ю: "(?:yu|ju|iu)", я: "(?:ya|ja|ia)"
};

/** Compare the entire title; catalog Cyrillic supplies the direction of conversion. */
export function matchesRussianTransliteration(latin, russian) {
  if (!/[а-яё]/iu.test(russian) || !/^[a-z0-9 ]+$/u.test(normalizeTitle(latin))) return false;
  if (/[^a-zа-яё0-9 ]/iu.test(normalizeTitle(russian))) return false;
  const pattern = [...String(russian).normalize("NFC").toLowerCase()].map(letter => {
    if (Object.hasOwn(LETTERS, letter)) return LETTERS[letter];
    if (/[a-z0-9]/u.test(letter)) return letter;
    return " ";
  }).join("").replace(/ +/g, " ").trim();
  return new RegExp(`^${pattern}$`, "u").test(normalizeTitle(latin));
}

/** Discovery spellings only; the complete catalog title must still round-trip. */
export function russianSearchSpellings(word) {
  const choices = {
    shch: ["щ"], sch: ["щ"], zh: ["ж"], kh: ["х"], ts: ["ц"], ch: ["ч"], sh: ["ш"],
    yo: ["ё"], jo: ["ё"], yu: ["ю"], ju: ["ю"], ya: ["я"], ja: ["я"],
    a: ["а"], b: ["б"], v: ["в"], g: ["г"], d: ["д"], e: ["е", "э", "ё"],
    z: ["з"], i: ["и", "й", "ы"], j: ["й", "ж"], k: ["к"], l: ["л"], m: ["м"],
    n: ["н"], o: ["о"], p: ["п"], r: ["р"], s: ["с"], t: ["т"], u: ["у"],
    f: ["ф"], h: ["х"], c: ["ц"], y: ["ы", "й"]
  };
  let candidates = [""];
  for (let at = 0; at < word.length;) {
    const token = Object.keys(choices).find(key => word.startsWith(key, at));
    if (!token) return [];
    candidates = candidates.flatMap(prefix => choices[token].map(letter => prefix + letter));
    // This is a query budget, never a confidence score or a truncated answer.
    if (candidates.length > 12) return [];
    at += token.length;
  }
  return candidates;
}
