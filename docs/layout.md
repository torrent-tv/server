# Browser app layout — which file owns what

The browser app in `public/` is plain ES modules without a bundler. Components
(`public/components/<name>/`) never import each other; they communicate through
events named in `public/shared/events.js` (`public/components/README.md`).
Domain logic is in `public/domain/`. The rules every change must keep are in
[`AGENTS.md`](../AGENTS.md).

## Playback

- `components/loading/loading.js` — the playback flow: transport orchestration,
  per-stream codec decisions, and the local-network permission steps.
- `domain/torrent-session.js` — proxy registration, playback plan, HLS start.
  Seeking is server-side: the page does not restart its session to seek.
- `domain/hls-player.js` — the hls.js wrapper.
- `domain/waiting-signal.js` — decides whether a `waiting` from the media
  element is a stall the viewer must be told about, or another track being
  refilled while the picture keeps running (changing a separately published
  audio track). Pure, tested, and the source of `FRAME_BLOCKED`.
- `domain/webrtc-proxy.js` — the WebRTC connection to a proxy and its
  data-channel fetch; it records the proxy's LAN probe URL (`lanProbeUrl`) once
  a private candidate is seen. Signalling is
  `domain/transport/signalling-session.js`; the permission request is
  `domain/local-network-permission.js`.

## Subtitles and track menus

- `components/loading/SubtitlePlayback.js` — subtitle track elements, sidecar
  loading, embedded cue delivery, reconnect subscription, the remembered
  subtitle choice, the report of the track a file opens with (which the start
  of playback waits for, `domain/subtitle-start.js`), and the single subtitle
  menu. It is the only thing that changes a track's mode. Each menu row names
  its track by a key kept for the life of the track (`domain/subtitle-menu.js`),
  never by its label: a label changes once the text has been read. The player
  draws the menu and reports the selected key; the subtitles key `c` is this
  page's, not media-chrome's (`hotkeys="noc"`). Provider subtitles:
  `SUBTITLES.md`.
- `domain/track-menu.js` — the shared keyed menu state and DOM updates for audio
  and subtitle choices; `domain/audio-menu.js` and `domain/subtitle-menu.js`
  adapt their metadata to it. Playback selection stays in each track type's
  component.

## Player and state

- `components/player/player.js` — the player UI; hides the playlist button when
  a torrent has a single media file.
- `domain/app-state.js`, `components/torrent-tv/torrent-tv.js`,
  `shared/state-derived-view.js` — the application state machine, its driver
  and state-derived views ([`AGENTS.md`](../AGENTS.md); the graph:
  [`app-state-machine.md`](app-state-machine.md)).
