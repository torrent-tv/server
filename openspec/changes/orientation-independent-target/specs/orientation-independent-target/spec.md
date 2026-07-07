# orientation-independent-target — delta spec

## ADDED Requirements

### Requirement: Transcode target resolution is orientation-independent

The browser SHALL size the transcode target resolution from the viewport's
long and short edges, so the target is identical in portrait and landscape and
provisions for the landscape (larger) case. The target MUST NOT be derived from
the current orientation's width/height or from the letterboxed video-element
box. Rotating the device during playback SHALL NOT change the target and SHALL
NOT force a transcode restart. The proxy SHALL cap this target to the source
resolution and MUST NOT upscale.

#### Scenario: Start in portrait, rotate to landscape

- **WHEN** playback of a transcoded title starts in portrait and the device is
  then rotated to landscape
- **THEN** the encode already carries enough pixels for landscape and no
  transcode restart or rebuffer occurs

#### Scenario: Ceiling for the realtime budget

- **WHEN** the realtime budget lowers the encode resolution for CPU
- **THEN** it scales down from this orientation-independent target, which acts
  as the ceiling; orientation alone never changes the encode resolution
