# app-shell — delta spec

## ADDED Requirements

### Requirement: The document never scrolls
The document (root and body) SHALL be clipped to the viewport
(`overflow: clip` on both `html` and `body`) with a fixed body height of one
dynamic viewport unit, so no user gesture, focus jump or device rotation can
scroll or offset the page. Views that need internal scrolling (e.g. the
playlist) provide their own scroll containers.

#### Scenario: Device rotation
- **WHEN** the device rotates between portrait and landscape during playback
- **THEN** the page shows no scroll offset — the player stays aligned to the
  viewport and the closed playlist drawer stays off-screen

#### Scenario: Scroll gestures on the app surface
- **WHEN** the user attempts to scroll or pan the page outside a scrollable
  view
- **THEN** the document does not move (internal containers such as the
  playlist still scroll their own content)
