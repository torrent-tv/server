# Proposal: Adopt media-chrome as the player UI

## Why

The in-playback UI is currently a mix of native browser controls (which differ
per browser and expose no cross-browser menus for subtitles, audio tracks or
quality) and bespoke overlay elements (playlist, close). Upcoming features —
embedded-subtitle selection, audio-track selection, manual quality override —
all need a consistent, extensible menu system on both desktop and mobile.
media-chrome (MIT, actively maintained by Mux) provides customizable player
controls as web components around our existing `<video>` element without
touching the playback engine or transport.

## What Changes

- Add media-chrome as the player UI layer: `<media-controller>` wraps the
  existing `<video slot="media">`. hls.js, the custom WebRTC data-channel
  loader, the prebuffer logic and the native-HLS fallback path stay unchanged.
- Replace native browser controls with a media-chrome control bar: play/pause,
  seek range, time display, mute/volume, fullscreen, captions menu, settings
  menu.
- Subtitle selection moves from native controls to `<media-captions-menu>`,
  driven by the existing `<track>` elements (external subtitles, server 0.8.19).
- New close button (top-chrome) that stops playback and returns to the
  file-picker / torrent screen — replaces the current bespoke close control.
- The playlist stays a custom component (media-chrome has no playlist), but is
  restyled with media-chrome CSS variables and opened from the control bar, so
  the player presents one visual language.
- Light and dark themes via media-chrome CSS variables, following
  `prefers-color-scheme`.
- Extension points (menu skeleton only, disabled until the proxy features
  land in separate changes): audio-track menu item and quality menu item
  (Auto + forced resolution).

## Capabilities

### New Capabilities

- `player-ui`: the in-playback user interface — controls, menus (captions,
  future audio/quality), playlist presentation, close action, theming, and
  behaviour on both the MSE (hls.js) and native-HLS playback paths.

### Modified Capabilities

<!-- none — openspec/specs/ is empty; this is the first spec-backed change -->

## Impact

- `public/index.html` — media-controller markup, script tag for media-chrome.
- `public/components/player/` — controls wiring, close button, playlist
  restyle.
- `public/domain/hls-player.js` — no transport changes; only ensures the video
  element stays compatible with media-controller state tracking.
- `server.js` — serve media-chrome from `/vendor` (same pattern as hls.js,
  from `node_modules`, no bundler).
- `package.json` — new dependency `media-chrome` (MIT). Version bump itself is
  done by `npm run patch` on release, not in this change.
- `CHANGELOG.md` — entry at current version + 1 patch.
- No server route changes, no proxy changes (no ha-addon bump required).
