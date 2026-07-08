# Tasks: Client log collection

> Discovery: most of the pipeline already existed in
> `public/shared/client-logger.js` + `routes/api/client-logs/post.js`
> (console tee of all levels, ring buffer 500, batch 50, 2 s flush,
> `sendBeacon` on pagehide/visibilitychange, device/browser tag, window
> `error`/`unhandledrejection`, size-capped sanitized ingestion). This change
> adds the missing pieces: correlation with the signalling session id and
> startup context. Pre-existing items are marked (existing).

## 1. Client

- [x] 1.1 (existing) ring buffer + console tee (all levels) + window
      `error`/`unhandledrejection`; ts + level captured
- [x] 1.2 (existing) flush loop: periodic POST `/api/client-logs`;
      `sendBeacon` on pagehide/visibilitychange; best-effort (swallowed
      failures, bounded buffer)
- [x] 1.3 First-batch metadata enriched: `window.env.version`, viewport,
      `navigator.connection?.effectiveType` added to the announce line
      (`ua` was already present)
- [x] 1.4 webrtc-proxy.js: keep the signalling sessionId (was dropped as
      `_sessionId`), log it, and push it to the forwarder via
      `window.__ttvClientLogger.setSignalSession(id)`; forwarder tags every
      batch with the current id (`signalSessionId`) and logs a line on each
      change (reconnect boundary)
- [x] 1.5 (existing) index.html loads the forwarder before the app modules

## 2. Server

- [x] 2.1 `routes/api/client-logs/post.js`: accept `signalSessionId`
      (36-char cap, sanitized), add `sig=<id>` to the per-line prefix when
      present; existing body/line/message caps and control-char sanitization
      retained
- [x] 2.2 Limits verified: control characters in tag/sessionId/signalSessionId
      and message are replaced with spaces (no log-line injection); malformed
      body → 204 with no entries logged

## 3. Verification and release

- [x] 3.1 Server route: live POSTs (with/without `signalSessionId`, and a
      control-char payload) → correct `sig=` prefix, sanitized single lines,
      204 responses
- [x] 3.2 Client (preview, real browser): forwarder present, console patched,
      announce line carries `ver/vp/net`; `setSignalSession` sets the id, the
      next batch body carries `signalSessionId`, a `signal-session=` marker
      line is emitted; server prints `[client … sig=…]` — full round trip
- [x] 3.3 Correlation dry run: a synthetic `[ice] … failed` line greps by the
      signalling id across the client-log output
- [ ] 3.4 CHANGELOG done (0.8.55); `npm run patch` + field-test with a tester
      session (release step — awaiting go-ahead)
