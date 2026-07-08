# Tasks: Client log collection

## 1. Client

- [ ] 1.1 `public/domain/client-log.js`: bounded ring buffer; interception
      of console.error/warn (all), console.debug (prefix-filtered:
      `[ice]`, `[torrent-tv]`, `[hls]`), window `error` +
      `unhandledrejection`; monotonic timestamps + start epoch
- [ ] 1.2 Flush loop: periodic POST `/api/client-logs` (single in-flight,
      re-buffer on failure, no burst retry); `sendBeacon` on `pagehide`
- [ ] 1.3 First-batch metadata: `window.env.version`, UA, viewport,
      `navigator.connection?.effectiveType`
- [ ] 1.4 webrtc-proxy.js: keep the signalling sessionId (today dropped as
      `_sessionId`), expose it; logger records every sessionId of the page
- [ ] 1.5 index.html: load the logger before the app modules so startup
      failures are captured

## 2. Server

- [ ] 2.1 `routes/api/client-logs/post.js` + server.js wiring: validate
      shape, enforce body/entry-count/message-length caps, per-IP rate
      limit (429), emit one `[client-log] ...` stdout line per entry
- [ ] 2.2 Verify limits: oversized, over-count and over-rate batches are
      rejected without affecting other routes

## 3. Verification and release

- [ ] 3.1 Preview: play a stream, confirm entries flow (periodic flush);
      close the tab, confirm the beacon tail arrives; kill the endpoint,
      confirm playback is unaffected
- [ ] 3.2 Correlation dry run: grep one sessionId across client-log lines
      and proxy `[webrtc] Session <id>` lines
- [ ] 3.3 CHANGELOG + `npm run patch`; field-test with a tester session
