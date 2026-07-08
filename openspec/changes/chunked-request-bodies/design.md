# Design: Chunked request bodies (client side)

Written to be executed as specified — wire format, constants and the
do-NOT list are normative. The frame layout MUST stay byte-identical to
the proxy-side design (proxy repo,
`openspec/changes/chunked-request-bodies/design.md`). Read before coding:

- `public/domain/webrtc-proxy.js`: `fetch()` (the single
  `this.#channel.send(JSON.stringify({type:"request", …}))`),
  `#onChannelMessage` (string vs ArrayBuffer dispatch),
  `#onResponseBinaryChunk` (the response-frame PARSER whose layout the
  request-frame BUILDER mirrors), `ping()`, the class fields block.

## Wire protocol (browser side of the additions)

    Received once per connection (JSON string):
      { type: "hello", proto: 1, version, maxRequestBytes }

    Sent to announce a chunked request (JSON string):
      { type: "request-start", requestId, method, path, query, headers,
        bodyBytes }

    Sent as body frames (BINARY, ArrayBuffer):
      byte 0        flags     bit 0: done, bit 1: aborted
      byte 1        idLen     requestId length
      bytes 2..2+N  requestId (ASCII)
      bytes 2+N..   payload   UTF-8 bytes of the body string

## Constants (module scope, next to the existing timeouts)

    REQUEST_CHUNK_BYTES = 64 * 1024
    REQUEST_CHUNK_THRESHOLD_BYTES = 128 * 1024
    REQUEST_BUFFERED_HIGH_BYTES = 1 * 1024 * 1024   // pause sending above
    REQUEST_BUFFERED_LOW_BYTES = 256 * 1024          // resume at (bufferedAmountLowThreshold)

## Hello handling

- New private fields: `#proxyHello = null`.
- In `#onChannelMessage`, before the pending-entry lookup: a parsed message
  with `type === "hello"` → store `{proto, version, maxRequestBytes}`
  (validate types; ignore malformed), `console.debug(
  "[dc] proxy hello v<version> maxRequestBytes=<n>")`, return. Old proxies
  never send it; nothing else changes.

## fetch(): the body path decision

Compute once per call: `bodyBytes = body == null ? 0 :
new TextEncoder().encode(body)` (keep the Uint8Array — it IS the payload
source; measure bytes, not string length).

    bodyBytes.byteLength <= REQUEST_CHUNK_THRESHOLD_BYTES  → legacy message
      (exactly today's send; includes bodyless requests)
    else if #proxyHello supports it (proto >= 1):
      if bodyBytes.byteLength > #proxyHello.maxRequestBytes →
        reject with a CLEAR error ("Request body of X MB exceeds the
        proxy's limit of Y MB.") — no send at all
      else → chunked path
    else (no hello — old proxy) → legacy single message (today's
      behaviour: works when the remote advertises enough, throws otherwise;
      the throw already converts to a rejected promise)

## Chunked send path

1. Send `request-start` (JSON) with `bodyBytes = payload.byteLength`.
2. Loop over the payload in REQUEST_CHUNK_BYTES slices; each frame =
   `buildFrame(flags, requestId, slice)` where the LAST slice carries
   flags bit 0. Build with a small helper mirroring
   `#onResponseBinaryChunk`'s layout (ASCII-encode the requestId once).
3. Backpressure between sends: if `this.#channel.bufferedAmount >
   REQUEST_BUFFERED_HIGH_BYTES`, await one `bufferedamountlow` event
   (set `bufferedAmountLowThreshold = REQUEST_BUFFERED_LOW_BYTES` once at
   channel creation) with the request's timeout still armed. The wait must
   also settle if the channel closes (listen once for `close` → reject).
4. Abort: if the request's AbortSignal fires while frames remain, stop the
   loop and send one frame with bit 1 (aborted) and empty payload —
   best-effort (`try/catch`) — then reject with the AbortError exactly as
   the existing abort path does.
5. Any synchronous `send()` throw → same conversion to a rejected promise
   as the existing catch around the legacy send.
6. The pending-entry lifecycle (timeout, resolve on response frames) is
   UNCHANGED — a chunked request's response arrives exactly like any other.

The chunked path makes `fetch()` internally async before the request is
fully on the wire; the returned promise semantics do not change (it already
resolved later than the send). Register the pending entry BEFORE sending
`request-start` (same order as today: entry first, then send), so an early
response/error cannot race the writer.

## Rules — do NOT

- Do NOT change the response handling, ping/pong, the legacy request
  message shape, or the reconnect/adoption logic.
- Do NOT chunk small or bodyless requests — the threshold keeps every
  existing proxy compatible and the common path single-message.
- Do NOT buffer-wait with polling; use the `bufferedamountlow` event.
- Do NOT let a mid-send abort leave the writer looping or the proxy
  waiting: abort frame + local reject, always.
- Frame layout is shared with the proxy design verbatim — if in doubt,
  match `#onResponseBinaryChunk`'s parsing byte-for-byte.
