# Tasks: Chunked request bodies (client side)

Execute in order; design.md is normative (frame layout shared verbatim with
the proxy-side change — proxy repo,
openspec/changes/chunked-request-bodies/design.md).

## 1. Implementation (`public/domain/webrtc-proxy.js`)

- [ ] 1.1 Constants + `#proxyHello` field + hello handling in
      `#onChannelMessage` (validate, store, `[dc] proxy hello …` debug
      line). `node --check`.
- [ ] 1.2 Frame builder helper (mirrors `#onResponseBinaryChunk` layout;
      bit 0 done, bit 1 aborted) + set
      `bufferedAmountLowThreshold = REQUEST_BUFFERED_LOW_BYTES` at channel
      creation.
- [ ] 1.3 `fetch()`: byte-measured body path decision (threshold / hello /
      cap fail-fast), chunked writer with backpressure, abort frame on
      signal, unchanged pending-entry lifecycle. `node --check`.

## 2. Verification

- [ ] 2.1 Unit (node): stub channel object capturing `send()` calls with a
      settable `bufferedAmount` — drive fetch() with a 600 KB body:
      request-start JSON + N frames, last frame bit 0, byte-concat equals
      the body; threshold body → single legacy message; no hello → legacy;
      body > cap → clear rejection, zero sends; abort mid-send → abort
      frame + AbortError.
- [ ] 2.2 Preview: app boots with zero console errors; a normal (small
      magnet) flow against the dev HA proxy is unchanged.
- [ ] 2.3 E2E with the proxy-side change (local stack or dev HA on 2.9.35):
      register the real Poirot `.torrent` via the UI — plan returns,
      playlist appears, an episode reaches the transcode phase; client log
      shows the hello line.

## 3. Release

- [ ] 3.1 CHANGELOG at current version + 1 patch (expected 0.8.58);
      `npm run patch`; verify live via `window.env.version` and a live
      Poirot registration once the proxy 2.9.35 is deployed.
