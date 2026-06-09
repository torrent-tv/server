## 0.8.7

- **Fix**: Playlist now marks the currently playing file. `Playlist` updated the tracked index on `PLAYER:SET_ACTIVE_MEDIA_FILE` but never re-rendered, so no item was highlighted. The active file's button now gets `aria-current="true"` (styled bold/red) and the highlight is refreshed on both render and active-file changes.
- **New**: MediaSession integration (`components/media-session/media-session.js`) — wires OS-level media controls (lock screen, notification shade, hardware keys, PiP) to the existing event model: metadata follows the active file; play/pause/seek act on the shared `<video>`; previous/next track dispatch `PLAYER:SELECT_MEDIA_FILE` for the adjacent video (disabled at list edges); stop dispatches `APP:RESET_TO_PICKER`. No-op where the API is unavailable.

## 0.8.6

- **Fix**: An unknown/undetected video codec is now treated as **unsupported** (transcoded to H.264) instead of assumed playable. Copying an undecodable codec over the WebRTC transport (which has no direct-playback fallback) produced a black screen with audio only. Also removed `mpeg4` (MPEG-4 Part 2: xvid/divx) and `mpeg2video` from the natively-supported video codec list, since mainstream browsers cannot decode them — they are now always transcoded.

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
