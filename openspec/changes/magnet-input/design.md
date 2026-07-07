# Design: Magnet link input

## Context

The browser parses `.torrent` files locally (`torrent-parser.js`) and hands
the loading flow a ready file list; a magnet URI has no file list until the
swarm metadata arrives. Proxy 2.9.26 provides
`GET /api/sources/:key/files` (resolves the torrent, waiting for metadata),
and the source registry accepted `sourceType: "magnet"` end-to-end all
along.

## Goals / Non-Goals

**Goals:** magnets through all input channels the `.torrent` file already
has (URL param, clipboard, input field); the rest of the pipeline unchanged.

**Non-Goals:** registering the site as a `magnet:` protocol handler
(possible later via `registerProtocolHandler`); magnet trackers/webseed
hints beyond what WebTorrent consumes itself.

## Decisions

1. **The magnet flow rejoins the torrent flow at the earliest possible
   point.** `session.openMagnetDetails()` creates a minimal `current`
   (`sourceType: "magnet"`, `sourceValue: <uri>`) — `registerSourceOnProxy`
   was already source-type-agnostic. After `/files` returns,
   `normalizeRemoteFileList` reshapes the proxy's inventory into exactly the
   entries the local parser produces (including stripping the torrent-name
   prefix WebTorrent adds to multi-file paths), and `classifyMediaFiles`
   (extracted into the parser module) regroups video/audio/subtitles. From
   `SET_MEDIA_FILES` on, the two flows are identical — playlist, subtitles,
   tracks, retry, cancel all work unchanged.
2. **Metadata wait rides the files route with a 180 s per-request timeout**
   (the transport-level `timeoutMs` added for subtitle extraction). The
   loading screen shows a dedicated status; cancel checkpoints cover the
   wait.
3. **Input channels**: `?magnet=` URL param (stripped from the URL like
   `?torrent=`); document-level paste of magnet TEXT (files keep priority);
   a text field in the picker whose Enter/submit starts the flow. A
   non-magnet submission shows a plain-language error.
4. **torrent-tv learns the file count from `SET_MEDIA_FILES`** — for
   magnets the count is unknown at flow start, and the error screen's
   "Choose File" button depends on it.

## Risks / Trade-offs

- [Cold magnet metadata can exceed 180 s on a dead swarm] → the flow fails
  with the explicit "no peers reachable" message; Retry-by-resubmitting is
  one paste away.
- [`relativePath` reconstruction differs from the .torrent parser for exotic
  layouts] → both parsers normalise to torrent-root-relative paths; a
  mismatch degrades subtitle matching only, not playback.
