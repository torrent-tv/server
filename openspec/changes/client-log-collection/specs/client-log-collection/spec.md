# client-log-collection — delta spec

## ADDED Requirements

### Requirement: Browser diagnostics are captured and delivered to the server

The browser SHALL capture its diagnostic output — `console.error` and
`console.warn` entirely, `console.debug` for the known prefixed channels
(`[ice]`, `[torrent-tv]`, `[hls]`), and global `error` /
`unhandledrejection` events — into a bounded in-memory buffer, and SHALL
deliver it to the server in batches: periodically during the session and via
`navigator.sendBeacon` when the page is hidden or closed. Capture SHALL be
on by default and SHALL NOT require any tester action. Delivery SHALL be
best-effort: a failed or rate-limited flush is not retried as a burst, never
raises a user-visible error, and never affects playback; when the buffer is
full the oldest entries are dropped first.

#### Scenario: Session logs arrive while the tester watches
- **WHEN** a viewer plays a video and the diagnostic channels produce output
- **THEN** the entries appear on the server within one flush interval,
  without the tester doing anything

#### Scenario: Tab closed right after a failure
- **WHEN** playback fails and the tester closes the tab before the next
  periodic flush
- **THEN** the buffered tail (including the failure lines) is still
  delivered via the page-hide beacon

#### Scenario: Log delivery must not hurt playback
- **WHEN** the log endpoint is unreachable or replies with an error
- **THEN** playback continues unaffected, no error is shown, and the buffer
  stays within its bound

### Requirement: Log entries are correlatable across browser, server and proxy

Every batch SHALL carry a per-page-load `clientId`, and entries SHALL be
associated with the signalling `sessionId`s assigned to the page — the same
identifiers the proxy logs as `[webrtc] Session <id>`. The first batch of a
page load SHALL also carry the app version, user agent, viewport size and
coarse connection type. Entry timestamps SHALL be monotonic within the page
load and mappable to absolute time.

#### Scenario: Joining the three views of one session
- **WHEN** a tester reports a bad session and the proxy log shows
  `[webrtc] Session abc12345`
- **THEN** filtering the server's client-log output by that sessionId yields
  the browser-side lines of the same session, and its clientId yields the
  full page timeline including reconnects under other sessionIds

### Requirement: The server ingests batches within strict bounds

The server SHALL accept log batches on a dedicated route and emit one
structured, prefixed line per entry to its standard output, preserving
clientId, sessionId, timestamp, level and message. It SHALL enforce a body
size limit, a maximum number of entries per batch, a per-entry message
length cap, and a per-IP rate limit; violating requests are rejected without
side effects on the rest of the service.

#### Scenario: Well-formed batch
- **WHEN** a client posts a batch within all limits
- **THEN** each entry becomes one greppable stdout line carrying the
  correlation fields

#### Scenario: Abusive or malformed traffic
- **WHEN** a request exceeds the size, count or rate limits, or does not
  parse
- **THEN** it is rejected with an appropriate status, nothing is logged as
  entries, and signalling/static serving remain unaffected
