# Proposal: Client log collection for field debugging

## Why

The project is in the hands of third-party testers. When a session goes wrong
("плохо работает"), the browser-side evidence — ICE transitions, loading
phases, HLS errors, timings — lives only in the tester's devtools console and
is gone by the time we hear about it. Diagnosing today means proxy-side
terminal access, tcpdump and guesswork; correlating the browser, proxy and
server views of one session is manual. The valuable log lines already exist
in the client code (`[ice]` in webrtc-proxy.js, `#logEvt` phases in
loading.js, console-only HLS errors) — they just never leave the device.

## What Changes

- **Client logger** (`public/domain/client-log.js`): a bounded in-memory
  buffer fed by intercepting `console.error` / `console.warn` entirely and
  `console.debug` for the already-prefixed diagnostic channels (`[ice]`,
  `[torrent-tv]`, `[hls]`). No changes to existing call sites.
- **Batched delivery**: the buffer is flushed to `POST /api/client-logs`
  every few seconds (or when it grows large); `navigator.sendBeacon` on
  `pagehide` delivers the tail when the tab closes or the device drops.
  Delivery failures never affect playback; the buffer is bounded either way.
- **Correlation**: every batch carries a per-page `clientId`
  (`crypto.randomUUID()`) and the signalling `sessionId`s the page has been
  assigned (currently received and discarded in webrtc-proxy.js) — the same
  IDs the proxy prints as `[webrtc] Session <id>`. The first batch also
  carries `window.env.version`, the user agent, viewport size and
  `navigator.connection?.effectiveType`.
- **Server ingestion** (`routes/api/client-logs/post.js`): validates and
  bounds the payload (body size, entries per batch, per-IP rate), then emits
  one structured, prefixed line per entry to stdout — readable on the
  droplet via `docker logs`, greppable by `clientId`/`sessionId`. No storage
  subsystem; a persistent volume is a possible later upgrade (design.md).
- **Enabled by default** for all viewers — POC-stage decision: testers will
  not opt in manually, and the point is capturing sessions we did not
  anticipate. Segment-level spam (`net-debug` per-segment lines) stays OFF.

## Capabilities

### New Capabilities

- `client-log-collection`: browser-side capture, batched delivery, and
  server-side ingestion of per-session diagnostic logs.

## Impact

- `public/domain/client-log.js` (new) — buffer, console interception, flush
  loop, sendBeacon tail.
- `public/domain/webrtc-proxy.js` — keep the signalling `sessionId` and
  expose it for correlation (today `_sessionId` is dropped).
- `index.html` — load the logger early (before the app modules) so startup
  errors are captured.
- `routes/api/client-logs/post.js` (new) + `server.js` wiring — ingestion
  route with limits.
- Server-only release; no proxy/addon change.
