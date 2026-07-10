# viewer-net-report — delta spec (server/client)

## ADDED Requirements

### Requirement: Playback reports measured link state to the proxy

During proxy-transcode playback the client SHALL periodically (~10 s) send
the transcode session a net report over the data channel containing the
rolling MEDIAN of recent per-fetch transfer throughput (Mbit/s, ~30 s
window) and the player's buffered seconds ahead. Sending SHALL be
best-effort (failures ignored, no retries) and SHALL stop when the session
is released or playback stops. Each send SHALL emit one `[torrent-tv]`
debug line so the client-log pipeline records what was reported.

#### Scenario: Cellular playback
- **WHEN** segments download at ~3 Mbit/s while a session is active
- **THEN** the proxy receives reports reflecting ~3 Mbit/s and the current
  buffer, roughly every 10 s, and the field log shows the reported values

#### Scenario: Session ends
- **WHEN** the viewer stops playback or the session is released
- **THEN** no further reports are sent

#### Scenario: Send failure
- **WHEN** a report POST fails (channel busy, transient error)
- **THEN** playback is unaffected and the next tick simply tries again
