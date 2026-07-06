# Design: Adopt media-chrome as the player UI

## Context

Playback today uses native browser controls plus bespoke overlay elements
(playlist button, close control). Subtitles (external files, server 0.8.19)
are attached as `<track>` elements and selected through the native controls,
which on Chrome/Firefox expose no menu UI for anything beyond captions
on/off, and nothing at all for audio tracks or quality.

The playback engine is intentionally custom and must not change:

- hls.js with a custom loader that fetches manifests/segments over a WebRTC
  data channel (`webrtc-hls-loader.js`);
- a native-HLS fallback (`<video src="…m3u8">`) on Safari without MSE;
- prebuffer logic that keeps the video paused while loading screens are shown;
- plain ES modules, no bundler; vendor libraries served from `node_modules`
  via the `/vendor` static route (hls.js already works this way).

## Goals / Non-Goals

**Goals:**

- One consistent, touch-friendly control UI on desktop and mobile, identical
  on the hls.js and native-HLS paths.
- Captions menu driven by the existing `<track>` elements.
- Close button returning to the file selection / torrent picker.
- Playlist visually integrated with the player (same design tokens).
- Light/dark theme following `prefers-color-scheme`.
- Menu extension points for the future audio-track and quality menus.

**Non-Goals:**

- Audio-track switching, quality/resolution override, embedded subtitles —
  these are separate changes (they need proxy-side support first).
- Replacing hls.js, the WebRTC transport, or any playback/codec decision
  logic.
- Redesigning the pre-playback loading screens.
- Localization.

## Decisions

1. **media-chrome, not Vidstack / video.js / plyr / shaka.**
   media-chrome is UI-only: it wraps our existing `<video>` (`slot="media"`)
   and reads state from the element, so the engine, custom loader and
   fallback paths stay untouched. MIT, actively maintained (Mux).
   Alternatives: Vidstack (MIT, active) manages the provider itself and its
   1.x line is still published under the `next` dist-tag; video.js brings its
   own HLS engine; plyr is unmaintained; shaka-player replaces hls.js
   entirely.

2. **Serve media-chrome from `/vendor` like hls.js.** Add `media-chrome` as a
   dependency and extend the vendor static mount to expose its `dist/` ESM
   bundle. No bundler is introduced.

3. **The `<video>` element remains ours.** `<media-controller>` wraps it; all
   existing wiring (pause under loading screens, prebuffer, subtitle track
   attachment, session restart on seek) is unchanged. The `controls`
   attribute is removed so native and custom controls do not double up.

4. **Captions menu uses native `textTracks`.** `<media-captions-menu>` reads
   the `<track>` elements we already create; no changes to subtitle loading.

5. **Future audio/quality menus are custom settings-menu items, not
   media-chrome's built-in `media-audio-track-menu`/`media-rendition-menu`.**
   The built-ins require the media element to expose `audioTracks` /
   `videoRenditions` (media-tracks polyfill or a custom media element such as
   hls-video-element). Our switching model is a server-side session restart,
   not an hls.js level switch, so custom `<media-settings-menu-item>` entries
   dispatching app events are the correct wiring. hls-video-element was
   rejected because it owns the hls.js instantiation and would conflict with
   the custom WebRTC loader. These menu items ship hidden in this change and
   are enabled by the later audio/quality changes.

6. **Theming via media-chrome CSS variables** (`--media-primary-color`,
   `--media-secondary-color`, `--media-control-background`, …) defined as two
   token sets under `prefers-color-scheme: light/dark`, scoped on
   `media-controller`. The playlist and close button reuse the same tokens.

7. **Close button** is a plain button in `slot="top-chrome"` dispatching the
   existing app events: back to the playlist for multi-file torrents,
   otherwise back to the torrent picker (mirrors current close behaviour).

8. **Same UI on the native-HLS fallback.** media-chrome tracks state of the
   media element regardless of MSE vs native playback, so old-iOS Safari
   keeps the same control bar. Verified in the spike (task 1); if a blocking
   iOS-specific defect is found, the fallback path may keep native controls
   as a temporary degradation, recorded in the spec.

## Risks / Trade-offs

- [media-chrome state tracking may fight the pause-under-loading logic] →
  spike task validates play/pause/seek event flow with the loading screens;
  loading screens stay outside `<media-controller>`.
- [iOS native-HLS quirks: seekable range on the synthetic VOD playlist,
  fullscreen behaviour] → test on a real device during the spike; degradation
  path is native controls on that platform only.
- [CSS collisions with existing overlays (loading, error, playlist)] → theme
  tokens scoped to `media-controller`; overlays keep their own stacking
  context.
- [No bundler: deep ESM imports must resolve] → use the self-contained
  `dist` bundle of media-chrome; verify no bare-specifier imports leak.
- [Browser cache can hide the new UI after deploy] → standard project caveat;
  verify with `window.env.version` + hard refresh.

## Migration Plan

Single release, no feature flag (small app, single deployment):

1. Land the change behind one commit; CHANGELOG entry at current
   `package.json` version + 1 patch.
2. Deploy via the standard flow (`npm run patch`, watchtower).
3. Verify live playback on desktop Chrome/Firefox, Android Chrome, iOS
   Safari (MSE path) — and, when hardware is available, old-iOS native path.
4. Rollback = revert commit + re-release (no data or protocol impact).

## Open Questions

- Old-iOS (pre-17.1) native-HLS behaviour with media-chrome — needs a real
  device; until then decision 8's degradation path stands.
- Whether the settings menu shows a disabled "Quality: Auto" entry or hides
  the item entirely until the proxy feature lands — default: hide.
