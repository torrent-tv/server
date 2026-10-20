# Chapters Component

This component renders navigation entries from the selected file's chapter
snapshot. It does not request metadata or control playback directly.

## Responsibilities

- Render available entries in source-timeline order with their title, type and start time.
- Mark the section containing the current playback position.
- Use the same duration-bounded section intervals and current-section selection as the player timeline.
- Request a seek through `PLAYER:REQUEST_SEEK`; the player forwards it to the existing media seek event.
- Keep pending, unsupported and error states distinct from a complete chapter-free answer.
- Show the list only when `PLAYER:PANEL_CHANGED` selects `chapters`.

## Coupling

The loading component owns chapter metadata requests and publishes snapshots via
`MEDIA_INFO:CHAPTERS`. The player owns the side-panel state and media element.
