# Proposal: Screen wake lock + rotation lock button (LOW priority, queued)

## Why

Two mobile annoyances during use:

1. The screen dims/locks during the loading phase (metadata, transcode
   warm-up, prebuffer — minutes with no video playing); a locked phone
   suspends the tab, kills the WebRTC data channel and breaks the playback
   attempt. During actual playback browsers keep the screen awake natively,
   so the loading phase is the real gap.
2. Auto-rotation flips the video when the viewer lies down; the OS-level
   rotation lock is the only remedy on iOS, but Android browsers expose
   `screen.orientation.lock()`.

## What Changes

- **Wake lock** (Screen Wake Lock API, supported everywhere incl. iOS 16.4+):
  acquired when torrent processing starts, held through loading and
  playback, released on pause/error/close; re-acquired on visibility
  return. No UI.
- **Rotation lock button**: shown ONLY when the API is actually available
  (feature detection: `screen.orientation && "lock" in screen.orientation` —
  Android browsers; iOS never shows it). Because lock() works only in
  fullscreen on mobile, the button either enters fullscreen together with
  locking or is shown only while fullscreen. Lives in the settings-menu
  extension point of the player.

## Capabilities

### New Capabilities

- `screen-wake`: wake-lock lifecycle tied to loading/playback states.

### Modified Capabilities

- `player-ui`: settings menu gains the conditional rotation-lock item.

## Impact

- `public/` — small wake-lock module wired to loading/player events; player
  settings-menu item with feature detection.
- No server/proxy changes.

## Priority

LOW — queued behind reliability (reachable-priority proxy selection,
connection-loss retry), track selection (embedded subtitles, audio), and
proxy observability (2.9.25).
