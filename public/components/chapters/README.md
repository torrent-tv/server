# Chapters Component

This component renders navigation entries from the selected file's chapter
snapshot. It does not request metadata or control playback directly.

## Responsibilities

- Render available entries in source-timeline order with their title and start time. Use source-declared parent identifiers to nest chapters; keep entries whose parent is not visible at the root.
- Mark the section containing the current playback position.
- Use the same duration-bounded section intervals and current-section selection as the player timeline.
- Toggle nested chapters with a separate disclosure button. Selecting a chapter requests a seek through `PLAYER:REQUEST_SEEK` and closes the side panel.
- Keep pending, unsupported and error states distinct from a complete chapter-free answer.
- Show the list only when `PLAYER:PANEL_CHANGED` selects `chapters`.

## Coupling

The loading component owns chapter metadata requests and publishes snapshots via
`MEDIA_INFO:CHAPTERS`. The player owns the side-panel state and media element.
