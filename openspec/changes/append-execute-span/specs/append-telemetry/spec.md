# append-telemetry — delta spec (server)

## ADDED Requirements

### Requirement: An append sample carries its execute span

Each append sample the page reports SHALL carry `executeMs`, the time from the
start of the append operation's execution to its completion as hls.js measures
it on the appended event, or `null` when hls.js gives no complete span.

#### Scenario: A complete span
- **GIVEN** an appended event whose `chunkMeta.buffering.video` has
  `executeStart` 105 and `executeEnd` 125
- **WHEN** the sample is recorded
- **THEN** its `executeMs` is 20, and its `elapsedMs` is still measured from
  the appending event

#### Scenario: No span
- **GIVEN** an appended event without `chunkMeta`, or with `executeStart` 0
- **WHEN** the sample is recorded
- **THEN** its `executeMs` is `null` and the sample is otherwise unchanged
