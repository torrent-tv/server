# Proposal: Audio-track menu and embedded subtitles in the player

## Why

Torrents carry several audio languages and embedded subtitles; the proxy
(2.9.26, change `track-selection`) now exposes the track inventory, maps a
chosen audio track and extracts embedded text subtitles as WebVTT. The
player's settings menu has had a hidden Audio extension point since the
media-chrome migration — time to light it up.

## What Changes

- **Audio menu**: the settings button appears when the active file has more
  than one audio track; the Audio submenu lists tracks labelled from
  language + `title` metadata. Picking a track replays the file through the
  remux/transcode path with `-map 0:a:N`, preserving the playback position
  (direct play always carries the container default, so a non-default
  choice forces the proxy path).
- **Embedded subtitles**: after playback starts, embedded TEXT subtitle
  tracks are fetched sequentially from `GET /api/subtitles` (generous
  per-request timeout — extraction reads to the last cue) and attached as
  `<track>` elements, joining the external subtitle files in the captions
  menu. Image-based tracks are skipped. The container's default flag is
  honoured unless an external subtitle already took the default slot.
- Transport: per-request `timeoutMs` on the WebRTC fetch (extractions
  outlive the 60 s default).
- Graceful degradation: against a pre-2.9.26 proxy the inventory is empty —
  no menu, no embedded subtitles, no errors.

## Capabilities

### New Capabilities

- `track-selection-ui`: audio menu behaviour and embedded-subtitle
  presentation.

### Modified Capabilities

- `player-ui`: the settings-menu extension point for Audio is now active
  (the Quality point stays hidden).

## Impact

- `public/domain/torrent-session.js` (plan fields, audioTrackIndex),
  `public/domain/webrtc-proxy.js` (timeoutMs), `public/shared/events.js`,
  `public/components/loading/loading.js` (selection state, forced remux,
  embedded fetch, labels), `public/components/player/player.js` +
  `index.html` (menu).
- Pairs with proxy 2.9.26; requires the ha-addon bump (0.2.48).
