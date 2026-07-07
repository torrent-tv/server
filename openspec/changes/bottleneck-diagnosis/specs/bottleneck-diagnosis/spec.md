# bottleneck-diagnosis — delta spec

## ADDED Requirements

### Requirement: Playback bottleneck is classified and logged
During playback the app SHALL periodically classify what is limiting playback
and log it. It SHALL distinguish client decode (dropped-frame ratio high
while the forward buffer holds) from an upstream limit (the forward buffer
draining toward empty) from healthy playback. The log line SHALL carry the
buffer level, its trend, and the dropped-frame ratio so a limit can be
diagnosed from the field logs.

#### Scenario: Client decode-limited
- **WHEN** the device drops a high fraction of frames while the buffer stays
  filled
- **THEN** the bottleneck is classified as client-decode

#### Scenario: Upstream-limited
- **WHEN** the forward buffer drains toward empty with few dropped frames
- **THEN** the bottleneck is classified as upstream (to be split into proxy
  CPU / download / delivery by the budget)

#### Scenario: Healthy
- **WHEN** the buffer holds and few frames drop
- **THEN** the bottleneck is classified as ok
