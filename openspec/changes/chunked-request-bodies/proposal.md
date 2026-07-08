# Proposal: Chunked request bodies over the data channel (client side)

## Why

`WebRtcProxy.fetch()` serialises the whole request — body included — into
ONE `channel.send()`. The body of a source registration is the
base64-encoded `.torrent`; a big multi-season pack (Poirot: 420 KB →
~560 KB base64) exceeded the proxy's default advertised message limit
(256 KB) and `send()` threw "Trying to send message larger than
max-message-size" — playback dead-ended after ~10 s of connecting.

Responses already stream as small binary frames; requests should be
symmetric. The proxy side (frame assembly, hello capability announcement,
and the 16 MB advertisement that keeps OLD cached browser bundles working)
is the proxy repo's `chunked-request-bodies` change.

## What Changes

- **Chunk writer in `WebRtcProxy.fetch()`.** When the UTF-8 byte length of
  the body exceeds a threshold AND the proxy has announced chunk support
  (hello), the browser sends `{type:"request-start", …, bodyBytes}` followed
  by binary frames in the response-frame layout (bit 0 = done, bit 1 =
  aborted), 64 KB each, with backpressure via
  `bufferedAmount`/`onbufferedamountlow`. Small bodies and bodyless
  requests keep the legacy single message (compatible with every proxy).
- **Hello consumption.** The proxy's `{type:"hello", proto, version,
  maxRequestBytes}` is recorded per connection: gates the chunked path,
  caps the sendable body (clear error beyond it), and the proxy version is
  logged for correlation.
- **Fallback**: no hello (old proxy) → legacy single send. For large bodies
  that is exactly today's behaviour — works against proxies advertising
  16 MB (pending 2.9.35+), throws against older ones (no regression; clear
  error surfaced).
- **Abort propagation**: an AbortSignal firing mid-body-send stops the
  writer and sends one abort frame so the proxy drops its partial state
  immediately instead of waiting out its TTL.

## Capabilities

### New Capabilities

- `chunked-request-bodies`: request-body transport on the browser side.

## Impact

- `public/domain/webrtc-proxy.js` — hello handling in `#onChannelMessage`;
  chunk writer + frame builder + backpressure in `fetch()`; constants.
- No other client files; server routes untouched; server-only release
  (expected 0.8.58), independent of the proxy release (safe in either
  order).
