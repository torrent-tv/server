# Design: Audio-track menu and embedded subtitles

## Context

Pairs with the proxy change `track-selection` (2.9.26): plan carries
`audioTracks`/`subtitleTracks`; `/api/transcode-sessions` takes
`audioTrackIndex`; `/api/subtitles` streams WebVTT. The player has hidden
settings-menu extension points since the media-chrome migration.

## Decisions

1. **Audio switch = replay via the existing switch path** (same file,
   position captured and restored) — identical machinery to Retry and to
   the playlist switch; no new playback path. A non-default track forces
   the proxy remux branch: direct play cannot select tracks
   (`forceAudioRemux` disables the direct-URL probes for that attempt).
2. **Menu is custom items, not media-chrome's `media-audio-track-menu`** —
   the built-in reads `audioTracks` off the media element (needs a custom
   media element); our switching is server-side. Items are
   `media-chrome-menu-item type="radio"` children of the Audio submenu;
   selection dispatches `PLAYER:SELECT_AUDIO_TRACK`, loading owns the state.
3. **Embedded subtitles load eagerly but sequentially** after playback
   starts, mirroring external subtitle files (they share the captions menu
   and the blob-URL lifecycle). Sequential = one extraction ffmpeg at a
   time on the proxy; a 10-minute per-request timeout covers full-file
   extraction on the transcode path where the file downloads anyway.
   Accepted v1 risk: on a cold direct-play file the extraction itself
   drives the download.
4. **Track labels** built from ffmpeg language tags (ISO 639-2 → 639-1 map
   + `Intl.DisplayNames`) and stream `title` metadata: "Japanese — PCM to
   FLAC", falling back to "Track N".
5. **Selection lifecycle**: audio choice resets on file switch and new
   torrent, survives Retry (same file). An out-of-range stored index (file
   changed under it) resets to 0 when the plan arrives.

## Risks / Trade-offs

- [Eager extraction of many embedded tracks loads the proxy] → sequential
  fetch; each is one ffmpeg with `-map 0:s:N` reading already-downloading
  data on the transcode path. Field-watch on the Yellow.
- [`media-chrome-menu-item` is an internal-ish element] → used only as a
  styled radio row + click target; a breaking rename degrades to an empty
  menu (settings button still hides when inventory is empty).
