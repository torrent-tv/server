# loading-cancel — delta spec

## ADDED Requirements

### Requirement: The loading flow can be cancelled
The loading view SHALL show a cancel control whenever it is visible. The
control SHALL abort the in-flight flow at any phase (metadata, plan polling,
transcode warm-up, prebuffer) without showing an error screen, releasing
pending requests and any transcode session. A cancelled flow MUST NOT start
playback afterwards.

#### Scenario: Cancel during a stalled load
- **WHEN** the user activates cancel while the loading screen waits on a
  stalled torrent
- **THEN** the flow stops silently (no error screen) and the transcode
  session, if any, is released

### Requirement: Cancel destination preserves choice
Cancelling SHALL return the user to the playlist (with the file list intact
and selectable) when the torrent has multiple video files, and to the
torrent picker otherwise.

#### Scenario: Multi-file torrent
- **WHEN** the user cancels loading of a file from a multi-file torrent
- **THEN** the playlist opens with all files listed and another file can be
  selected immediately

#### Scenario: Single-file torrent
- **WHEN** the user cancels loading of a single-file torrent
- **THEN** the torrent picker is shown
