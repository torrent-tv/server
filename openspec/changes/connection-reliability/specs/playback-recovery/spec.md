# playback-recovery — delta spec

## ADDED Requirements

### Requirement: Connection loss is detected and surfaced
The app SHALL detect the loss of an established proxy connection (data
channel closed or connection failed, excluding closes initiated by the app
itself) and, when a file was playing, SHALL show the error screen with a
clear "connection lost" description and a Retry action alongside the
existing navigation actions.

#### Scenario: Proxy dies mid-playback
- **WHEN** the data channel closes during playback and the app did not close
  it
- **THEN** the error screen appears with a connection-lost message and a
  Retry button

### Requirement: Retry resumes the same file at the same position
Retry SHALL reconnect (the proxy is re-selected — possibly a different pool
node), restart playback of the same file, and seek to the position captured
at the moment of loss. The captured session snapshot SHALL survive the
error-screen cleanup.

#### Scenario: Successful retry
- **WHEN** the user activates Retry after a mid-playback connection loss
- **THEN** the loading flow runs again for the same file and playback
  continues from (approximately) the captured position

#### Scenario: Retry fails too
- **WHEN** the retry attempt itself fails (e.g. no proxy available)
- **THEN** the standard error screen is shown with the failure description
  (without a stale Retry state)
