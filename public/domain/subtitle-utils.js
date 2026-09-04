/**
 * @file What the viewer is shown about a subtitle track, and which track the
 * container itself asks for.
 *
 * What a track IS — its language, its flags, who made it, and which file beside
 * the picture it lives in — is read by the PROXY, in `services/torrent/`, and
 * arrives here in the playback plan.
 *
 * This side used to read it again, and the two readings were not the same rule:
 * the pairing here accepted any name beginning with the video's, while the
 * proxy's required the base names to be equal. Nothing compared the answers.
 * Measured 2026-09-04 over the 115 torrents in `Dropbox/trn` — 1249 video
 * files, ten pairings differing, every one of them a `<base>.<language>.ass`
 * name this side paired and the proxy did not. The difference reached the
 * viewer, because the proxy warms what IT paired while this side offered what
 * IT paired: a track offered but never warmed waits for its first piece off the
 * swarm.
 *
 * So what is left here is the two things that really are the browser's: the
 * words shown on screen, and the container's own request for a track.
 */

/**
 * @typedef {{ code: string, name: string, group: string | null,
 *   isForced?: boolean, isHearingImpaired?: boolean, isDefault?: boolean }} SubtitleInfo
 */





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
