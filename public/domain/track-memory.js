/**
 * @file What a viewer's choice of soundtrack or subtitles IS, in terms that
 * survive a change of episode.
 *
 * A track NUMBER does not survive one. The next file of a season pack may carry
 * a different set in a different order, so index 1 there is not the track the
 * viewer picked here, and following the number would put them in another
 * language without saying so. What does carry over is the pair the viewer
 * actually chose by: the LANGUAGE, and WHO made that track — the releaser, which
 * is the bracketed team a sidecar's own path names and which already appears in
 * the menu as `Russian (Stan WarHammer & Nesitach)`.
 *
 * Both halves are already read elsewhere and are not re-derived here: the
 * language from the container or from the file's name (`subtitle-utils.js`), the
 * releaser from the path. This module only says when two of those answers are
 * the same choice, and which entry of a list a remembered choice names.
 *
 * **No near matches.** A remembered choice either has its exact counterpart in
 * the next episode or it does not, and where it does not the file's own default
 * plays — which is what opening the first episode does, so the viewer meets a
 * behaviour they have already seen. Ranking the alternatives (same language,
 * another team; same team, another language) would be inventing a preference
 * nobody stated. Settled with the user 2026-09-03.
 */

/**
 * One track's identity, or null where it has none worth remembering.
 *
 * Case and surrounding spaces are dropped from both halves: the same team writes
 * its name differently between episodes often enough that keeping the
 * difference would lose the match, and nothing here displays these values.
 *
 * @param {{ code?: string | null, releaser?: string | null }} parts
 * @returns {{ code: string, releaser: string | null } | null}
 */
export function trackIdentity(parts) {
  const code = typeof parts?.code === "string" ? parts.code.trim().toLowerCase() : "";
  const releaser = typeof parts?.releaser === "string" ? parts.releaser.trim().toLowerCase() : "";
  // A track whose language is unknown is not a choice that can be carried: the
  // next episode's unknown track is a different track, not the same one.
  if (code.length === 0 || code === "und") {
    return null;
  }
  return { code, releaser: releaser.length > 0 ? releaser : null };
}

/**
 * Whether two identities name the same choice.
 *
 * A track with no releaser matches only another with no releaser. An embedded
 * track usually has none, and treating "no team" as "any team" would let an
 * embedded English track answer a choice of a particular team's Russian one.
 *
 * @param {{ code: string, releaser: string | null } | null} left
 * @param {{ code: string, releaser: string | null } | null} right
 * @returns {boolean}
 */
export function sameTrackIdentity(left, right) {
  if (!left || !right) {
    return false;
  }
  return left.code === right.code && (left.releaser ?? null) === (right.releaser ?? null);
}

/**
 * Which entry of a list the remembered choice names.
 *
 * @param {Array<{ code: string, releaser: string | null } | null>} identities -
 *   One per candidate, in the candidates' own order; null where a candidate has
 *   no identity.
 * @param {{ code: string, releaser: string | null } | null} wanted
 * @returns {number} The position, or -1 when nothing matches — which is the
 *   answer that means "let the file decide", not an error.
 */
export function findTrackByIdentity(identities, wanted) {
  if (!wanted || !Array.isArray(identities)) {
    return -1;
  }
  return identities.findIndex((candidate) => sameTrackIdentity(candidate, wanted));
}
