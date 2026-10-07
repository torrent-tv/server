/**
 * @file Which soundtrack a file opens with (torrent-tv/meta#49).
 *
 * A track the container marks unusable — Matroska `FlagEnabled` 0, MP4
 * `track_enabled` cleared — is never offered in the menu, and it must not be
 * played either: "A disabled track … is treated as if it were not present"
 * (ISO/IEC 14496-12 §8.3.2). The page opens on track 0 or on the one chosen in
 * an earlier episode, and either can be such a track.
 */

/**
 * The number of the soundtrack to open with: the one asked for when the file
 * marks it usable, otherwise the first usable one. Where none is usable, the
 * number asked for is kept: there is nothing better to play.
 *
 * @param {Array<{ index: number, isEnabled?: boolean }>} tracks
 * @param {number} wanted
 * @returns {number}
 */
export function openingAudioTrack(tracks, wanted) {
  const usable = (Array.isArray(tracks) ? tracks : []).filter((track) => track?.isEnabled !== false);
  if (usable.some((track) => track.index === wanted)) return wanted;
  return Number.isInteger(usable[0]?.index) ? usable[0].index : wanted;
}
