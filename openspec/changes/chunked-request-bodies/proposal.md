# Proposal: Chunked request bodies over the data channel (client side)

## Why

`WebRtcProxy.fetch()` serialises the whole request — body included — into
ONE `channel.send()`. The body of a source registration is the
base64-encoded `.torrent`; a big multi-season pack (Poirot: 420 KB →
~560 KB base64) exceeded the proxy's default advertised message limit
(256 KB) and `send()` threw "Trying to send message larger than
max-message-size" — playback dead-ended after ~10 s of connecting.

Responses already stream as small binary frames; requests should be
symmetric. The proxy side (frame assembly, limits) is the proxy repo's
`chunked-request-bodies` change.

## What Changes

- **Chunk writer in `WebRtcProxy.fetch()`.** When the UTF-8 byte length of
  the body exceeds a threshold (128 KB), the browser sends
  `{type:"request-start", …, bodyBytes}` followed by binary frames in the
  response-frame layout (bit 0 = done, bit 1 = aborted), 64 KB each, with
  backpressure via `bufferedAmount`/`onbufferedamountlow`. Small bodies
  and bodyless requests keep the single-message form (fewer messages on
  the common path).
- **No capability negotiation** — POC: single-proxy pool released in
  lockstep (proxy first, then server); the browser assumes the proxy
  understands frames.
- **Abort propagation**: an AbortSignal firing mid-body-send stops the
  writer and sends one abort frame so the proxy drops its partial state
  immediately instead of waiting out its TTL.

## Capabilities

### New Capabilities

- `chunked-request-bodies`: request-body transport on the browser side.

## Impact

- `public/domain/webrtc-proxy.js` — chunk writer + frame builder +
  backpressure in `fetch()`; constants.
- No other client files; server routes untouched; server-only release
  (expected 0.8.58), AFTER the proxy 2.9.35 is deployed.
