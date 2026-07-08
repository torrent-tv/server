# cold-start — delta spec (client)

## ADDED Requirements

### Requirement: Every successful start reports where its time went

On reaching playback readiness through the proxy-served flow, the client
SHALL log a single console summary with the total and per-phase durations
(transport acquisition, playback plan, prepare/first data, prebuffer), on
the channel the client-log pipeline forwards, correlated with the session
ids. Failed or cancelled flows log nothing extra.

#### Scenario: Field cold-start distribution
- **WHEN** testers start playbacks over a day
- **THEN** the server log contains one `cold-start …` line per successful
  start, greppable by client/session id, giving per-phase timings without
  screen recordings

### Requirement: Playback starts once the delivery margin is proven

The prebuffer SHALL start playback before reaching its adaptive target when
the measured fill rate has sustained a healthy surplus (≥ 1.35× realtime)
over the full measurement window and at least 10 seconds are buffered.
Lower fill rates SHALL keep the current adaptive-target behaviour
unchanged. The start decision SHALL be visible in the existing prebuffer
log line (early vs target).

#### Scenario: Healthy band starts sooner
- **WHEN** delivery sustains ≥ 1.35× realtime for the whole window and 10 s
  are buffered
- **THEN** playback starts then, instead of waiting for the (capped) target

#### Scenario: Thin margin keeps the deep buffer
- **WHEN** delivery hovers just above realtime (fill rate < 1.35)
- **THEN** the start condition is exactly as before this change

#### Scenario: Burst does not fool the shortcut
- **WHEN** a burst fills 10 s quickly but the rate has not been sustained
  for the full window
- **THEN** the shortcut does not trigger (anti-stutter guarantee retained)
