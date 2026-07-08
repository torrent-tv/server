# chunked-request-bodies — delta spec (client)

## ADDED Requirements

### Requirement: Large request bodies are sent in chunks when the proxy
### supports it

When a request body exceeds the single-message threshold and the connected
proxy has announced chunk support, the browser SHALL send the request as an
announcement message followed by bounded binary body frames (the response
frame layout mirrored), applying backpressure via the channel's buffered
amount. Bodies at or under the threshold, and bodyless requests, SHALL keep
the legacy single-message form. A body exceeding the proxy's announced cap
SHALL fail fast with a clear error, without sending.

#### Scenario: Multi-season torrent registers
- **WHEN** the user picks a file from a torrent whose base64 source body is
  ~560 KB and the proxy has sent its hello
- **THEN** registration succeeds via chunked frames and playback proceeds;
  no "message larger than max-message-size" error exists on this path

#### Scenario: Small requests unchanged
- **WHEN** any request's body is at or under the threshold (or absent)
- **THEN** the wire format is exactly today's single message

#### Scenario: Old proxy without hello
- **WHEN** the proxy never announced chunk support
- **THEN** the browser sends the legacy single message regardless of size
  (today's behaviour and compatibility)

#### Scenario: Abort mid-send
- **WHEN** the request's AbortSignal fires while body frames remain
- **THEN** the writer stops, one abort frame is sent best-effort, and the
  promise rejects with the AbortError as today

### Requirement: The proxy's hello is consumed and recorded

The browser SHALL record the proxy's hello (protocol level, version,
request-body cap) per connection, use it to gate the chunked path, and log
the proxy version for session correlation. Malformed or absent hellos leave
the connection on legacy behaviour.

#### Scenario: Field debugging
- **WHEN** a tester session is inspected in the server log
- **THEN** the client's lines include the connected proxy's version from
  the hello
