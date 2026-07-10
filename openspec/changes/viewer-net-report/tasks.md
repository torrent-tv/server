# Tasks: Viewer net report (client)

## 1. Implementation

- [x] 1.1 Rolling sample store: per-fetch `{ bytes, ms, at }` from the
      existing dc-load instrumentation, ~30 s window; median Mbit/s
      accessor (transfers only, ignore cache/zero-ms samples).
- [x] 1.2 Reporter: 10 s interval tied to the transcode-session lifecycle
      (start on session create, stop on release/stop); reads
      `bufferedAheadSec` from the video element; POSTs
      `/api/transcode-sessions/:id/net-report` via the transport;
      fire-and-forget; one `[torrent-tv]` debug line per send.
- [x] 1.3 Preview: module loads clean; reporter no-ops without a session.

## 2. Release

- [ ] 2.1 CHANGELOG + `npm run patch` — AFTER proxy/addon with
      `adaptive-bitrate` are live.
- [ ] 2.2 Field: cellular run shows reports in the client log and
      `budget downshift (link)` on the proxy; stream settles at a rung the
      link sustains.
