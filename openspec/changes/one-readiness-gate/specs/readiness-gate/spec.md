# readiness-gate — delta spec

## ADDED Requirements

### Requirement: One readiness verdict
The page SHALL decide from `playbackReadiness` whether to release the picture
only through `readinessVerdict` in `public/domain/readiness-gate.js`, at start
and after a seek. A missing, null or unsupported-version forecast SHALL NOT
release the picture.

#### Scenario: Null forecast after a seek
- **WHEN** the proxy answers the seek hold's progress request with `playbackReadiness: null`
- **THEN** the picture stays held and the page asks again

#### Scenario: Answer asked before the seek was reported
- **WHEN** the progress request was sent before the proxy was told of the seek
- **THEN** the answer is not read (stale), whatever it says

#### Scenario: Timestamp gap after a seek
- **WHEN** a fresh answer after a seek has `reason: "media-continuity-unavailable"`
- **THEN** playback fails with the same message as at start

#### Scenario: Same verdicts at start and after a seek
- **WHEN** the same forecast reaches the start gate and the seek gate
- **THEN** both release, wait or fail alike

## REMOVED Requirements

### Requirement: A proxy that states no forecast releases the seek hold
**Reason**: the contract says a missing version does not authorise playback;
the proxy sends `null` for a superseded action.
