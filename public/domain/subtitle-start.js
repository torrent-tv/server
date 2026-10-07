/**
 * @file Which subtitle a file opens with, and whether the start of playback
 * still has to wait for it (torrent-tv/meta#8).
 *
 * The first half is the rule `SubtitlePlayback` has always applied, now in one
 * place so that the start wait asks the same question the track modes are set
 * by. The second half is the page's share of the wait: the proxy decides when
 * the chosen track has been read (`playbackReadiness.subtitles`); the page only
 * refuses to release the start on a forecast taken before its own choice
 * reached the proxy, since that forecast could not have weighed it.
 */

import { containerDefaultSubtitleIndex } from "./subtitle-utils.js";
import { findTrackByIdentity, sameTrackIdentity, trackIdentity } from "./track-memory.js";
import { trackLanguageCode, trackLanguageTag } from "./track-language.js";

/**
 * The text tracks of a file that are offered at all. `isEnabled` is
 * FlagEnabled: a track the file marks unusable keeps its number and is never
 * offered.
 *
 * @param {object[]} tracks
 * @returns {object[]}
 */
export function offeredSubtitleTracks(tracks) {
  return (Array.isArray(tracks) ? tracks : []).filter((t) => t?.textBased === true && t?.isEnabled !== false);
}

/**
 * What an embedded track IS, for carrying a choice of it to the next episode.
 *
 * @param {object} track
 * @returns {{ code: string, releaser: string | null } | null}
 */
export function embeddedSubtitleIdentity(track) {
  const title = typeof track?.title === "string" ? track.title.trim() : "";
  return trackIdentity({
    code: trackLanguageCode(trackLanguageTag(track) || ""),
    releaser: title.length > 0 ? title : null
  });
}

/**
 * What the file opens with, in order:
 *
 * 1. the viewer's own choice in the previous episode, where this file carries
 *    its exact counterpart — turning subtitles off is such a choice too;
 * 2. the container's `FlagDefault`, where the viewer chose nothing or nothing
 *    here answers what they chose.
 *
 * @param {{ tracks?: object[], sidecars?: object[],
 *   remembered?: { code: string, releaser: string | null } | { off: true } | null }} file
 * @returns {{ off: true } | { identity: { code: string, releaser: string | null } } | { planIndex: number } | null}
 *   null when nothing is to be shown.
 */
export function subtitleStartChoice({ tracks = [], sidecars = [], remembered = null } = {}) {
  if (remembered?.off === true) {
    return { off: true };
  }
  // Every track the file can offer, as one list: a remembered choice with no
  // counterpart here falls back to the container's default, which no single
  // track can tell. Built from what the file DECLARES, because the tracks are
  // attached over time — a subtitle file costs a fetch.
  if (remembered) {
    const identities = [
      ...offeredSubtitleTracks(tracks).map(embeddedSubtitleIdentity),
      ...(Array.isArray(sidecars) ? sidecars : []).map((sub) => trackIdentity({
        code: sub?.naming?.code ?? "und",
        releaser: sub?.naming?.releaser ?? null
      }))
    ];
    if (findTrackByIdentity(identities, remembered) >= 0) {
      return { identity: remembered };
    }
  }
  const planIndex = containerDefaultSubtitleIndex(tracks);
  return planIndex === null ? null : { planIndex };
}

/**
 * The EMBEDDED track the file opens with, or null — none, a subtitle FILE, or
 * a default the file itself marks unusable.
 *
 * @param {Parameters<typeof subtitleStartChoice>[0]} file
 * @returns {number | null}
 */
export function embeddedStartTrackIndex(file) {
  const choice = subtitleStartChoice(file);
  const offered = offeredSubtitleTracks(file?.tracks);
  if (choice && "planIndex" in choice) {
    return offered.some((track) => track.index === choice.planIndex) ? choice.planIndex : null;
  }
  if (choice && "identity" in choice) {
    return offered.find((track) => sameTrackIdentity(embeddedSubtitleIdentity(track), choice.identity))?.index ?? null;
  }
  return null;
}

/**
 * Whether a forecast the proxy calls ready may release the start, as far as
 * the subtitle the file opens with is concerned.
 *
 * @param {{ state: "none" | "reporting" | "reported" | "refused", reportedAt?: number }} start -
 *   Where the page's report of the start track stands.
 * @param {object} readiness - The proxy's `playbackReadiness`, already ready.
 * @param {number} readingRequestedAt - When the progress request that carried
 *   it was sent, on the same clock as `reportedAt`.
 * @returns {"subtitles-pending" | "proxy-unaware" | null} null releases the
 *   start; `proxy-unaware` releases it too, from a proxy that predates the term.
 */
export function subtitleStartHold(start, readiness, readingRequestedAt) {
  if (start?.state === "reporting") {
    return "subtitles-pending";
  }
  if (start?.state !== "reported") {
    return null;
  }
  if (!readiness || !Object.hasOwn(readiness, "subtitles")) {
    return "proxy-unaware";
  }
  // The selection is recorded before the proxy answers the report, so a
  // reading requested after that answer has weighed it. One requested before
  // it has not, whatever it says.
  return readingRequestedAt >= start.reportedAt ? null : "subtitles-pending";
}
