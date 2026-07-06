# Proposal: Installable web app (PWA manifest) (LOW priority, queued)

## Why

The site is an app in behaviour (screen-bounded, no document scroll, video
playback) but installs like nothing: no manifest, no icons. An installable
web app opens without browser chrome (standalone), gets a home-screen icon,
and the manifest `orientation` field sets the installed app's default
orientation on Android — partially solving rotation without any API.

## What Changes

- `manifest.webmanifest`: name, short_name, icons (192/512 + maskable),
  `display: standalone`, `background_color`/`theme_color` matching the
  theme tokens, `orientation` preference.
- `<link rel="manifest">` + `apple-touch-icon` + `theme-color` meta in
  `index.html` (iOS installs via Share → Add to Home Screen and needs the
  Apple icon).
- Icon assets (the ".torrent" wordmark styling can be reused).

## Known constraints

- iOS home-screen web apps: Wake Lock API works only from iOS 18.4
  (WebKit bug 254545, fixed); WebRTC works in home-screen apps since
  iOS 14.3 — both acceptable.
- No service worker planned (not required for installability in current
  Chrome; offline mode is meaningless for a streaming app).

## Capabilities

### New Capabilities

- `installability`: manifest, icons, install metadata.

### Modified Capabilities

<!-- none -->

## Impact

- `public/manifest.webmanifest`, icon files, `index.html` head.
- No server/proxy logic changes (static files only).

## Priority

LOW — queued behind reliability, track selection and proxy observability.
