## 0.8.35

- **New**: The loading screen has a Cancel button (OpenSpec change `cancel-loading`, capability `loading-cancel`). Previously a stalled load could only be waited out or escaped by reloading the page. Cancel aborts the in-flight flow at any phase — transport acquisition, plan polling, transcode warm-up, prebuffer — silently (no error screen), releases pending requests and the transcode session, and returns to the playlist for multi-file torrents (file list stays usable; the open data channel is reused for the next selection) or to the torrent picker otherwise. A cancelled flow can never late-start playback (cooperative AbortError checkpoints at the await boundaries).

## 0.8.34

- **Chore**: All CSS sizes are relative units now — the stray `px` literals (error-button border, player control padding and icon sizes, playlist font and focus outline, and the 1024px/1440px media-query breakpoints) are converted to `rem` (identical rendering at the default 16px root; rem breakpoints additionally respect the user's browser font-size setting). Documented as a convention in the OpenSpec project context.

## 0.8.33

- **Fix**: Error-screen buttons get `margin-inline-end: 1rem` — restores the spacing between "Retry" and the navigation button that 0.8.32 removed together with the buggy adjacent-sibling margin (an end margin cannot indent a single visible button because of a hidden sibling; the trailing margin on the last button is harmless).

## 0.8.32

- **Fix**: Error-screen buttons are no longer blue on iOS. Buttons do not inherit text colour and iOS paints them system blue (the `currentColor` border followed); every view's CSS now forces `color: inherit` on its buttons, so they render the view's text colour — white text and border in the dark theme, black in the light one.
- **Fix**: Removed the between-buttons `margin-inline-start` on the error screen — the adjacent-sibling rule also counted hidden buttons, indenting a single visible button.

## 0.8.31

- **New**: Reachable-first proxy selection (OpenSpec change `connection-reliability`, capability `proxy-selection`). `/api/proxy-clients/health` now returns `reachable` (dial-back probe result, collected since 0.8.22 but never exposed) and `sameNetwork` (the browser's public IP — `CF-Connecting-IP` — equals the proxy's reported external IP) per proxy. The selector prefers candidates with `reachable || sameNetwork`; when none qualify, all candidates stay eligible — a failed inbound-TCP probe does not prove WebRTC cannot connect (hole punching), so this is a preference, never a filter. Previously a remote viewer could be handed an unreachable node and wait out a 30 s timeout while a verified-reachable one sat in the list.
- **New**: Connection-loss retry (capability `playback-recovery`). When the WebRTC data channel dies mid-playback (proxy restart, network change), the app now detects it (new `onConnectionLost` hook on the transport; deliberate closes are excluded), captures the session, file and playback position BEFORE the error flow clears them, and shows the error screen with a "Retry" button alongside the usual navigation. Retry reconnects through the normal selector (possibly to a different pool node), restarts the same file and seeks back to the captured position — instead of today's silent stall that forced a full reload from zero.

## 0.8.30

- **Fix**: The document can no longer scroll on mobile (seen after landscape/portrait rotation: the player shifted sideways and the off-screen playlist drawer became reachable). `overflow: clip` now sits on BOTH `html` and `body` — clipping the root removes the page scroller entirely, instead of relying on body→viewport overflow propagation that iOS applies unreliably — and the body height is a fixed `100dvh` (was `min-block-size`, which let the body exceed the screen while `dvh` recalculated during rotation). Scrollable views (playlist) keep their own scroll containers. Spec: new `app-shell` capability, change `lock-viewport`.
- **Chore**: Dark-theme text softened from pure white to `#e6e6e6` to avoid halation on the black background; the accent (progress bar, hover) stays pure white and now reads slightly brighter than text.

## 0.8.29

- **New**: The app views (torrent picker, loading, error) follow the OS/browser colour scheme. A shared token set (`css/theme.css`, `color-scheme: light dark` + `light-dark()`) drives all view colours: light keeps the current palette (white / black / `#c00`), dark is monochrome white-on-black (background black; black text and the red accent both become white). The player keeps its own scheme-aware tokens. Spec: `view-theming`, change `view-color-scheme`.

## 0.8.28

- **Fix**: The first row of a freshly opened playlist no longer looks selected. The drawer focuses its first button on open (keyboard accessibility) and focus shared the red fill of the currently-playing row; focus is now an inset accent outline, the red fill is reserved for hover and the playing file. The playing-file marker itself persists across errors and drawer close/open and is cleared only on return to the torrent picker (spec: `player-ui`, change `playlist-selection-state`).

## 0.8.27

- **Fix**: "Choose File" on the playback-error screen no longer opens an empty playlist. The playlist cleared its file list on every `ERROR:SHOW` (a full reset), while the error screen's "Choose File" action returns the user to that very playlist; on error the drawer now only closes and the file list survives. The list is still cleared on `APP:RESET_TO_PICKER` and replaced on new media files.
- **Fix**: Modal dialogs (torrent picker, loading, error) no longer show a focus outline (the blue frame seen on mobile) — `showModal()` focuses the dialog element and the browser drew its focus ring around it; each view's CSS now sets `outline: none` on its dialog.

## 0.8.26

- **Fix**: Pinch and double-tap zoom are disabled (viewport meta `maximum-scale=1, user-scalable=no` + `touch-action: manipulation`) — this is an app, and accidental zoom over the video hurt more than it helped. Note: iOS Safari ignores `user-scalable=no` for pinch, but `touch-action` kills the double-tap zoom there.

## 0.8.25

- **Fix**: Playlist rows are full-width, so the hover/current highlight spans the whole drawer instead of only the text.
- **Chore**: The mobile debug console (eruda) no longer loads for every visitor — it is opt-in via `?debug` (any value) or `#debug` in the URL. The dialog-follow logic (eruda moves into the open modal `<dialog>`) is kept and now also catches a dialog opened before the script finished loading.
- **New**: The player UI is now [media-chrome](https://www.media-chrome.org/) (MIT, Mux) instead of native browser controls + the bespoke hover menu. A `<media-controller>` wraps the same `<video>` element — hls.js with the WebRTC data-channel loader and the native-HLS fallback are untouched. Control bar: play, mute/volume, time, seek range, captions menu (driven by the existing external-subtitle `<track>` elements), fullscreen; a close button in the top bar returns to the torrent picker; a playlist button in the control bar (hidden for single-file torrents, as before). The old `#player__menu` overlay (hover-revealed close/playlist buttons) is removed. The playlist drawer is restyled with the shared theme tokens and now also closes on a click/tap outside it (media tap gestures are suppressed while it is open, so that click never toggles play/pause). Light/dark themes follow `prefers-color-scheme`. The settings menu ships as a hidden extension point for the future audio-track and quality menu items. media-chrome is served from `/vendor/media-chrome/` (same `node_modules` pattern as hls.js).

## 0.8.24

- **Fix**: Cold-start playback no longer fails with "Data channel request timed out" on a torrent whose peers are still connecting. The browser now **polls** the playback plan (`loading.js` loop over `prepareProxyPlaybackPlan`, up to `PLAN_WAIT_MS` = 180 s) instead of issuing one request that blocks until the transport's 60 s timeout: the proxy returns `pending` quickly while the file header downloads (proxy 2.9.24), and the `/stats` poll keeps showing live peers / speed / header % the whole time. A truly dead torrent (no peers) now fails with a clear message ("Torrent isn't downloading — no peers reachable…") instead of a generic timeout. Pairs with proxy 2.9.24; ship together.

## 0.8.23

- **New**: Browser → server log forwarding (debugging aid). `public/shared/client-logger.js` (loaded first, before the component modules) patches `console.log/info/debug/warn/error` and captures uncaught `error`/`unhandledrejection`, then batches the lines to `POST /api/client-logs` over plain HTTPS (with `sendBeacon` on page hide). The server (`routes/api/client-logs/post.js`) writes each line to the container log as `[client <device>/<browser> <sessionId>] <ts> <level>: <msg>`, readable via `docker logs` / `ssh do` — so iPhone/eruda logs no longer need copy-pasting, and logs are captured even when the WebRTC data channel never connects (the failures we most want to see). Each line is tagged with a device/browser label parsed from the UA (e.g. `iPhone/Safari`, `Windows/Chrome`) and a short per-page session id. Best-effort and capped (≤50 lines/request, ≤2000 chars/line, control chars flattened so a forwarded line can't inject fake log lines); uses original console refs internally so a failed POST can't loop.

## 0.8.22

- **New**: Dial-back reachability probe for proxies (`services/reachability-prober.js`). When a proxy reports its UPnP-mapped external endpoint over the tunnel (new `proxy-endpoint` message), the server connects to `http://<external-ip>:<port>/healthz` **from the droplet** — the same external vantage a viewer has — and records whether it is actually reachable from the internet (a router can accept a UPnP mapping that is still unreachable behind CGNAT/double-NAT, so the report alone is not trusted). Result is stored per proxy (`endpoint`/`reachable`/`lastProbedAt` on the client record) and re-checked every 5 min for connected proxies. The tunnel message handler is now bound to the originating `proxyId`. Not yet surfaced to the browser (endpoint selection is a later step).

## 0.8.19

- **New**: External subtitle support. When a torrent contains subtitle files (`.srt`, `.ass`, `.ssa`, `.vtt`, `.webvtt`) alongside video files, the player now fetches and attaches them as `<track>` elements after playback starts. Language is detected from directory names (`ENG/`, `RUS/`, `KOR/` …) and filename suffixes (`_rus_AT_Team`, `_pol_Nyan` …); the release-group name is included in the track label (e.g. "Russian (AT Team)"). SRT and VTT are loaded as-is; ASS/SSA are converted to WebVTT with formatting tags stripped. Track selection uses the browser's native subtitle controls. Subtitle tracks are cleared when switching to another video file or resetting.

## 0.8.18

- **Fix**: The progress bar no longer jumps to 15% and then drops back to ~0 (or stalls at 15%) when a torrent is selected. `#processPlayback` set a fixed `setProgress(15)` before phase 0 started; phase 0's floor (3.3%) is lower, so without the monotonic clamp the bar dropped, and with it the bar stayed pinned at 15% until the header passed ~45%. Removed the pre-phase `15%` so phase 0 owns the 0–33% band from the start.
- **Fix**: Phase 1 (transcode) now shows "Preparing first segment… %" from 0% (relaxed `segmentProcessed > 0` to `>= 0`), so the band fills from the first poll instead of only after the first encoded second.
- **Chore**: `[evt]` diagnostics for the progress bar: `setProgress` logs `progress bar=X% req=Y%` (applied vs requested, to reveal monotonic clamping) and `#setPhaseProgress` logs `progress phase=N within=X%`. Lets the "3 steps / no intermediate stages" behaviour be confirmed from logs.

## 0.8.17

- **New**: Adaptive pre-buffer cushion. Instead of a fixed 15 s, `#waitForPrebuffer` now measures the fill rate `R` (media-seconds buffered per wall-second, while the video is paused = the production+delivery rate) over a rolling 1.5 s window and sizes the cushion from the margin over realtime (`R − 1`): comfortable margin → small cushion (~6 s, start sooner), margin near zero → large cushion (capped 25 s). Falls back to 15 s until the rate is measurable, with a 30 s absolute timeout. The cap stays under hls.js `maxBufferLength` (30) and the proxy look-ahead window (~32 s) so buffering ahead never triggers a seek-restart. Adds `[evt] prebuffer target/ready/timeout` logs.

## 0.8.16

- **New**: The download (metadata) screen now shows progress and ETA toward the **next phase** instead of only the whole-file percentage. Using the proxy's `headerBytes`/`headerDownloadedBytes`, it renders `To next phase: Z% • ETA ~Ts` (how much of the header/index is downloaded before the codec probe / transcode can start). Peers, download speed and the overall file line are kept. Coarse (piece granularity) for this iteration.
- **New**: The `<progress>` bar is now divided into three equal thirds for the pre-playback phases — download (0–33%), transcode first segment (33–66%), buffering (66–100%) — and each phase fills its own third from its own 0–100% progress (`#setPhaseProgress`). The bar is also monotonic (only moves forward, except an explicit reset to 0 on a new file), so within-phase fluctuations and the warmup→first-segment transition no longer make it jump back.

## 0.8.15

- **Fix**: Loading status no longer flickers between "Preparing first segment… / ETA" and "Buffering…". Both the transcode progress poll (~1 s) and the pre-buffer wait (250 ms) were writing the loading status concurrently, so the text alternated. The progress poll now stops after `#ensureVideoReady` (first-segment phase), and only `#waitForPrebuffer` writes the status during the cushion fill (`loading.js` `#playWithProxyTranscode`).

## 0.8.14

- **Fix**: The pre-buffer no longer flickers "Buffering… N / target" while audio plays. `Loading.#waitForPrebuffer` now pauses the `<video>` for the whole pre-buffer wait (and re-asserts pause if leftover play-intent resumes it). Previously the video kept playing under the loading screen, draining the buffer faster than the ~1× transcode filled it, so `bufferedAhead` never reached the target — the loading view stuck until the timeout, updating the fluctuating counter (looked like flicker) while audio was heard. Playback now starts only when the player is revealed (`Player.#onShow`).
- **Chore**: Temporary `[evt]` diagnostics for view/playback causes: `Player` logs `view=player shown/hidden`, `player.play reason=show`, `player.pause reason=hidden`; `Loading` logs `view=loading shown/hidden cause=…` and `player.pause reason=prebuffer`; `TorrentTV` logs `transition→PLAYING/ERROR cause=…`. Correlate with the existing `<video>` event log to see exactly what shows/hides a view and what starts/stops playback.

## 0.8.13

- **Fix**: Nothing plays while the player is hidden. `Player`'s `visible` setter now pauses the `<video>` whenever the player is hidden (loading/pre-buffer screen, error, reset); playback is (re)started only in `#onShow` on reveal. Previously a hidden `<video>` (`display:none`) kept emitting audio — on a multi-file torrent the player was revealed once for the playlist (giving the element play-intent), so when a selected file's data arrived the audio played under the loading screen before the player was shown. Now audio and the first frame appear together.

## 0.8.12

- **Fix**: Audio no longer plays underneath the loading / pre-buffer screen. Playback now starts only when the player view is **revealed** (`Player` on `PLAYER:SHOW`), not eagerly inside the HLS loader. `hls-player.js` previously called `video.play()` right after the manifest parsed — so on desktop (autoplay allowed) the video played, and its audio was audible, during the ~15 s pre-buffer wait while only the buffering overlay was visible. hls.js keeps filling the buffer while paused, so the cushion still builds; now the first frame and the sound begin together when the player appears. (iOS autoplay is still blocked outside a gesture — the user taps the native control, unchanged.)
- **Chore**: Extra gap diagnostics to verify the PTS-gap fix per branch: `hls-player.js` logs each `bufferStalledError`/`bufferSeekOverHole` with a UTC timestamp, `currentTime` and the jumped `hole` size; `loading.js` adds a periodic `buffer-health` tick (every 10 s while playing) showing `currentTime`, buffered-ahead and the number of buffered ranges. Correlate with the proxy's `branch=A/B` tag to attribute any remaining glitch.

## 0.8.11

- **Chore**: Temporary `[evt]` diagnostics with **UTC** `HH:MM:SS.mmm` timestamps (same zone/format as the proxy logger, so the two logs line up exactly) to correlate the browser timeline with the proxy's logs: transcode-session **create/release** (`torrent-session.js`), `<video>` **seeking/seeked/waiting/playing/pause/ended/stalled/error** with `currentTime` and buffered-ahead (`loading.js`), and a timestamp added to the existing `[net-debug] dc-load` line (`webrtc-hls-loader.js`).

## 0.8.10

- **Fix**: Switching to another video file now releases the previous transcode session immediately (`Loading.#switchToVideoFile` calls `TorrentSession.releaseActiveTranscodeSessions`). Previously the old session kept its ffmpeg running until page unload, so switching episodes left two encodes competing for the (ARM) CPU and both dropped below realtime → stalls. Only one transcode runs per viewer now.
- **New**: Pre-buffer cushion before playback. After the first segment is ready, `Loading` now waits until ~15 s of video is buffered ahead (`#waitForPrebuffer`, with a 25 s timeout fallback and a "Buffering…" status) before revealing the player, so a transient production/delivery dip right after start no longer stalls immediately. hls.js is also configured with an explicit forward buffer (`maxBufferLength` 30 s) kept under the proxy's look-ahead window so banking ahead never triggers a seek-restart.

## 0.8.9

- **Fix**: Playlist now highlights the picked file immediately on click (`#onListClick` calls `#updateActiveHighlight`), instead of waiting for the `PLAYER:SET_ACTIVE_MEDIA_FILE` round-trip. The active-file event remains the source of truth for programmatic playback.

## 0.8.8

- **Fix**: An unknown/undetected video codec is now treated as **unsupported** (transcoded to H.264) instead of assumed playable. Copying an undecodable codec over the WebRTC transport (which has no direct-playback fallback) produced a black screen with audio only. Also removed `mpeg4` (MPEG-4 Part 2: xvid/divx) and `mpeg2video` from the natively-supported video codec list, since mainstream browsers cannot decode them — they are now always transcoded.
- **Fix**: Playlist now marks the currently playing file. `Playlist` updated the tracked index on `PLAYER:SET_ACTIVE_MEDIA_FILE` but never re-rendered, so no item was highlighted. The active file's button now gets `aria-current="true"` (styled bold/red) and the highlight is refreshed on both render and active-file changes.
- **New**: MediaSession integration (`components/media-session/media-session.js`) — wires OS-level media controls (lock screen, notification shade, hardware keys, PiP) to the existing event model: metadata follows the active file; play/pause/seek act on the shared `<video>`; previous/next track dispatch `PLAYER:SELECT_MEDIA_FILE` for the adjacent video (disabled at list edges); stop dispatches `APP:RESET_TO_PICKER`. No-op where the API is unavailable.

## 0.8.2

- **Fix**: Loading status now keeps moving until the first segment is ready, instead of freezing on a stale "Transcoding 0%". The synthetic VOD playlist is ready instantly, so `waitForHlsPlaylist` stopped polling almost immediately; `loading.js` now polls the transcode session's `/progress` (via `TorrentSession.fetchActiveTranscodeProgress`) throughout `#ensureVideoReady` and renders progress oriented to the **first segment** — "Starting transcoder… X%" during ffmpeg warmup, then "Preparing first segment… X%" with a dynamic ETA derived from the encode speed and the proxy's `segmentDurationSec`. Previously the percentage was computed against the whole-file transcode and barely moved.

## 0.8.0

- **Fix**: iOS playback no longer fails with `NotAllowedError`. The `<video>` element gains the `playsinline` attribute (inline playback by default; fullscreen still available via native controls), and `hls-player.js` now tolerates the autoplay-policy rejection (`NotAllowedError`) on both the hls.js and native-HLS `play()` paths instead of surfacing it as a fatal "format not supported" error. Playback starts when the user taps play.
- **Fix**: Static assets are served with `Cache-Control: no-cache, must-revalidate` (revalidated via ETag/If-None-Match on every request) so deploys are picked up immediately instead of being hidden by a multi-hour browser cache. Note: Cloudflare's "Browser Cache TTL" must be set to "Respect Existing Headers" for this to take effect at the edge.
- **New**: WebRTC data-channel response bodies are received as binary frames (`webrtc-proxy.js`), removing the ~33% base64 overhead and JSON decode cost. Backward compatible — the client still decodes the legacy base64 `response-chunk` format, so it works with an older proxy. Deploy the server before the proxy.
- **Chore**: Temporary `[ios-debug]` diagnostics in the playback-ready path (`loading.js`) for iOS troubleshooting; to be removed once verified. CSP relaxed (`script-src 'unsafe-eval'`, `cdn.jsdelivr.net`) to allow on-device debugging with eruda (script tag currently commented out).

## 0.5.1

- **Fix**: Error view now shows exactly one button — **"Choose File"** when the torrent has multiple video files (so the user can pick a different one without re-uploading), **"New Torrent"** in all other cases. Previously both buttons were visible simultaneously.

## 0.4.4

- **New**: Live torrent stats during metadata wait — `Loading` polls `GET /api/sources/:sourceKey/stats` every 2 s and shows peer count, download speed, and file download progress while the proxy pre-fetches the MOOV atom. The torrent source is now registered before the playback plan request so the stats endpoint is available immediately.
- **New**: Error view redesigned — two distinct action buttons replace the single "Back" button: **"New Torrent"** (always shown, resets to picker) and **"Choose File"** (shown only when the torrent has multiple video files, returns to the playlist). CSS refactored to use `.error__action` class for consistent button styling.

## 0.4.3

- **New**: Seek-to-position HLS — `torrent-session.js` attaches a debounced (600 ms) `seeking` event handler after HLS playback starts. When the user scrubs beyond the already-transcoded portion, the handler creates a new transcode session from the seek position (`startPositionSeconds`) and switches HLS.js to the new playlist URL without interrupting playback of the old stream.
- **New**: `hls-player.js` accepts `startPosition` in play options and sets `hls.startPosition` before loading the source, so HLS.js begins buffering at the correct offset.
- **New**: `playHls` callback signature extended to accept a third `playOptions` argument; `loading.js` merges it with the HLS loader config.
- **Fix**: `waitForHlsPlaylist` in `torrent-session.js` now resolves on `#EXTINF:` (first HLS segment present) instead of `#EXT-X-ENDLIST` (full transcode done). Playback starts within seconds rather than after the entire file is transcoded.

## 0.4.2

- **Fix**: HLS.js `MANIFEST_PARSED` timeout increased; fatal error handling tightened.

## 0.3.0

- **Fix**: Static files now correctly sync from image to nginx volume on every container start — `docker-entrypoint.sh` does a clean `rm -rf` of the volume contents followed by `cp -rp` from `/app/public`, guaranteeing removed files also disappear after an image update.
- **Chore**: Dockerfile — create `/app/public-volume` with `app:app` ownership before `USER app` so the entrypoint can write to the volume without root; add `ENTRYPOINT ["sh", "/app/docker-entrypoint.sh"]`.
- **Fix**: Watchtower — set `DOCKER_API_VERSION=1.45` env var in `docker-compose.prod.yml` so the Docker SDK doesn't default to API 1.25 (which the daemon rejects); add `--debug` flag for visibility.

## 0.1.1

- **Fix**: Docker volume stale static files — added `docker-entrypoint.sh` that syncs `/app/public` from the image into the shared nginx volume on every container start. Nginx now always serves fresh JS/HTML after an image update without manual volume removal.
- **Fix**: `npm run docker:build` on Windows — added `.npmrc` with `script-shell=bash` so `$npm_package_version` expands correctly in npm scripts when running under Git Bash.
- **Chore**: `infra/docker-compose.yml` volume mount moved from `/app/public` to `/app/public-volume` so the volume no longer shadows image files.
- **Chore**: `infra/prod.sh` updated to `pull` then `up --remove-orphans` for cleaner deploys.

## 0.1.0

- **New**: WebRTC signalling server — replaced direct HTTP proxy registration with a WebSocket tunnel endpoint. The server brokers SDP offer/answer and ICE candidates between browser and proxy; all video data flows directly over the WebRTC data channel.
- **New**: `npm run patch / minor / major` scripts — bump the package version, build and push a versioned Docker image (`ghcr.io/torrent-tv/server:<version>` + `:latest`), and push git tags in one command.
