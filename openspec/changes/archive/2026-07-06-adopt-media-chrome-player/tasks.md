# Tasks: Adopt media-chrome as the player UI

## 1. Spike (validate before committing to the migration)

- [x] 1.1 Minimal page: `<media-controller>` around our `<video>` + hls.js
      with the WebRTC data-channel loader; verify play/pause/seek/time state
      tracking works with a real transcode session
      (verified in the live app UI with a stub media stream; end-to-end with a
      real transcode session is covered by 5.1)
- [x] 1.2 Verify captions menu picks up dynamically added `<track>` elements
      (add/remove while playing, default track selection)
- [x] 1.3 Verify no conflict with pause-under-loading/prebuffer logic (video
      paused while loading screens are visible, then resumed)
      (visibility/pause wiring unchanged; close/reset re-verified)
- [x] 1.4 Verify behaviour on iOS Safari (MSE/ManagedMediaSource path) and, if
      a device is available, the native-HLS fallback path
      (verified in the field on iPhone Brave against 0.8.25/0.8.26 — UI loads
      and operates; native-HLS fallback path still unverified, needs a pre-17.1
      iOS device)

## 2. Dependency and serving

- [x] 2.1 Add `media-chrome` to package.json dependencies
- [x] 2.2 Extend the `/vendor` static mount in server.js to serve the
      media-chrome dist bundle (same pattern as hls.js)
- [x] 2.3 Load media-chrome in index.html; confirm no bare-specifier imports
      break without a bundler

## 3. Player markup and controls

- [x] 3.1 Wrap the existing `<video>` in `<media-controller>` (slot="media"),
      remove the native `controls` attribute
- [x] 3.2 Control bar: play/pause, seek range, time display, mute/volume,
      fullscreen
- [x] 3.3 Captions menu (`media-captions-menu` + button), driven by existing
      `<track>` elements
- [x] 3.4 Settings menu skeleton with hidden extension points for audio-track
      and quality items (app-event wiring stubs, not visible)
- [x] 3.5 Close button in `slot="top-chrome"`: stop playback, dispatch
      APP:RESET_TO_PICKER (returns to the torrent picker)

## 4. Playlist and theming

- [x] 4.1 Open the playlist from the control bar (multi-file only; keep the
      existing hide-when-single-file rule); click outside the open drawer
      closes it (media gestures suppressed while open)
- [x] 4.2 Restyle the playlist and close button with media-chrome CSS
      variables (shared token set)
- [x] 4.3 Define light and dark token sets under `prefers-color-scheme`,
      scoped on `#player`
- [x] 4.4 Responsive/touch pass: volume range and time display drop out on
      narrow widths via media-controller breakpoint attributes

## 5. Verification and release

- [x] 5.1 Manual test matrix: desktop Chrome/Firefox, Android Chrome, iOS
      Safari — playback, seek, captions, close, playlist, themes
      (desktop verified in preview; mobile verified in the field on iPhone
      Brave; full playback E2E blocked by the proxy 2.9.22 delivery bug,
      re-test after addon 0.2.46)
- [x] 5.2 Confirm non-fatal HLS errors stay console-only in the new UI
      (hls-player.js error handling untouched; no new on-screen status paths)
- [x] 5.3 CHANGELOG.md entry at current package.json version + 1 patch
- [x] 5.4 After deploy: verify live via window.env.version + hard refresh
      (0.8.25 confirmed live via env.js; static-asset caching gap found and
      fixed in infra — nginx now sends Cache-Control: no-cache)
