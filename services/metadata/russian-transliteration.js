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
