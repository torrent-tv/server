# chunked-request-bodies — delta spec (client)

## ADDED Requirements

### Requirement: Large request bodies are sent in chunks

When a request body exceeds the single-message threshold, the browser SHALL
send the request as an announcement message followed by bounded binary body
frames (the response frame layout mirrored), applying backpressure via the
channel's buffered amount. Bodies at or under the threshold, and bodyless
requests, SHALL keep the single-message form.

#### Scenario: Multi-season torrent registers
- **WHEN** the user picks a file from a torrent whose base64 source body is
  ~560 KB
- **THEN** registration succeeds via chunked frames and playback proceeds;
  no "message larger than max-message-size" error exists on this path

#### Scenario: Small requests unchanged
- **WHEN** any request's body is at or under the threshold (or absent)
- **THEN** the wire format is exactly today's single message

#### Scenario: Abort mid-send
- **WHEN** the request's AbortSignal fires while body frames remain
- **THEN** the writer stops, one abort frame is sent best-effort, and the
  promise rejects with the AbortError as today
