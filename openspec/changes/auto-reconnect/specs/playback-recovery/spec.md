# playback-recovery — delta spec

## MODIFIED Requirements

### Requirement: Connection loss is detected and surfaced

The app SHALL detect the loss of an established proxy connection (data
channel closed or connection failed, excluding closes initiated by the app
itself) and, when a file was playing, SHALL attempt automatic recovery
BEFORE surfacing anything: while recovery to the same proxy is in progress
the player keeps playing from its buffer with no user-visible change; only
recovery paths that cannot be seamless (a different proxy, a rebuild) show
the loading view; the error screen (with the manual Retry) is shown only
after the automatic attempts are exhausted.

#### Scenario: Transient path loss, seamless recovery
- **WHEN** the data channel dies during playback and a reconnect to the
  same proxy succeeds while the player still has buffered media
- **THEN** playback never visibly stops, no overlay or error appears, and
  fetching resumes over the new connection

#### Scenario: Automation fails
- **WHEN** all automatic attempts fail
- **THEN** the error screen appears with the connection-lost message and a
  Retry button, exactly as before this change

## ADDED Requirements

### Requirement: Recovery is layered — seamless first, rebuild second,
### manual last

The automatic recovery SHALL first rebuild the connection to the proxy the
playback was using (same candidate policy, short per-attempt timeout, one
short-backoff repeat, no permission UI, no player teardown) and swap the
transport under the live player; only then SHALL it fall back to the
standard full re-selection with the loading view and an automated replay of
the manual-Retry flow (player rebuild + server-side seek to the captured
position). The manual Retry path and its event contract SHALL remain
unchanged as the final fallback.

#### Scenario: Same proxy alive, warm sessions
- **WHEN** the same proxy accepts the new connection within the ffmpeg/
  torrent idle windows
- **THEN** the same HLS session continues over the new channel — no player
  rebuild, no seek, no re-transcode

#### Scenario: Proxy gone, pool has another node
- **WHEN** the same proxy no longer answers but another pool proxy is
  available
- **THEN** the final attempt re-selects, the loading view explains the
  reconnect, and playback resumes near the captured position on the new
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

Every attempt (number, same-proxy vs re-selection, seamless vs rebuild,
failure reason) SHALL be logged on the `[torrent-tv]`-prefixed console
channel, so the client-log pipeline delivers reconnect cycles to the server
log correlated with the signalling session ids. The seamless path SHALL
produce no user-facing output — console/log only.

#### Scenario: Post-hoc session debugging
- **WHEN** a tester reports a bad mobile session
- **THEN** the server log shows the client's reconnect attempts and
  outcomes next to the proxy's `[webrtc] Session <id>` lines for the same
  session
