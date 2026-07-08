# playback-recovery — delta spec

## MODIFIED Requirements

### Requirement: Connection loss is detected and surfaced

The app SHALL detect the loss of an established proxy connection (data
channel closed or connection failed, excluding closes initiated by the app
itself) and, when a file was playing, SHALL attempt automatic recovery
BEFORE surfacing an error: the loading view appears with a reconnecting
status and a working Cancel action, and the error screen (with the manual
Retry) is shown only after the automatic attempts are exhausted.

#### Scenario: Proxy path dies mid-playback and recovers
- **WHEN** the data channel closes during playback and the app did not
  close it, and a reconnect attempt succeeds
- **THEN** playback resumes at (approximately) the captured position with
  no user action and the error screen is never shown

#### Scenario: Automation fails
- **WHEN** all automatic attempts fail
- **THEN** the error screen appears with the connection-lost message and a
  Retry button, exactly as before this change

## ADDED Requirements

### Requirement: Reconnect prefers the proxy that was just working

The automatic recovery SHALL first retry the same proxy the playback was
using (rebuilding the connection with the same candidate policy, under a
short per-attempt timeout, with one short-backoff repeat), and only then
fall back to the standard full proxy re-selection. Same-proxy attempts
SHALL NOT trigger any permission UI.

#### Scenario: Transient path loss, proxy alive
- **WHEN** the loss was a transient network event and the same proxy is
  still reachable
- **THEN** the first or second attempt reconnects to it and playback
  resumes, typically within ~15 seconds of the loss

#### Scenario: Proxy gone, pool has another node
- **WHEN** the same proxy no longer answers but another pool proxy is
  available
- **THEN** the final attempt re-selects and playback resumes on the new
  proxy

### Requirement: Recovery is offline-aware and loop-guarded

When the browser reports no network connectivity, the loop SHALL wait
(bounded) for connectivity to return before spending an attempt. Cancel
SHALL abort the recovery silently at any point. If playback keeps being
lost immediately after each recovery, the app SHALL stop after a small
number of consecutive cycles and show the error screen; surviving playback
for a stabilisation period resets that count.

#### Scenario: Mobile network transition
- **WHEN** the device switches networks and `navigator.onLine` is false at
  loss time
- **THEN** the loop waits for the `online` event (up to its bound) and then
  reconnects, instead of failing attempts into a dead network

#### Scenario: User cancels during recovery
- **WHEN** the user activates Cancel while the loop is running
- **THEN** recovery stops silently with the standard cancel navigation and
  no error screen

#### Scenario: Pathological relapse
- **WHEN** playback dies again immediately after each successful recovery,
  three cycles in a row
- **THEN** the app stops auto-reconnecting and shows the error screen

### Requirement: Recovery attempts are observable in the field

Every attempt (number, same-proxy vs re-selection, failure reason) SHALL be
logged on the `[torrent-tv]`-prefixed console channel, so the client-log
pipeline delivers reconnect cycles to the server log correlated with the
signalling session ids.

#### Scenario: Post-hoc session debugging
- **WHEN** a tester reports a bad mobile session
- **THEN** the server log shows the client's reconnect attempts and
  outcomes next to the proxy's `[webrtc] Session <id>` lines for the same
  session
