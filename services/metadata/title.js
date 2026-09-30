/**
 * @file How two spellings of one title are compared.
 *
 * A release writes `Agatha_Christie`s_Poirot`, the provider writes
 * `Agatha Christie's Poirot`; a release writes `Nausicaa`, the provider
 * `Nausicaä`. Both sides are reduced by the same function and then compared for
 * EQUALITY — no similarity score. A near miss is a miss: a wrong poster is worse
 * than none, and a similarity threshold would be a chosen number deciding which
 * stranger's film is shown.
 */

/** Apostrophes and their look-alikes, removed rather than turned into a space. */
const APOSTROPHES = /['’‘`´ʼ]/g;

/**
 * A title reduced to what two spellings of it share.
 *
 * Diacritics are removed after canonical decomposition, so `ä` and `a` agree;
 * this also turns Cyrillic `й` into `и`, which is harmless because both sides
 * pass through the same function.
 *
 * @param {unknown} text
 * @returns {string}
 */
export function normalizeTitle(text) {
  return String(text ?? "")
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(APOSTROPHES, "")
    .replace(/&/g, " and ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}
