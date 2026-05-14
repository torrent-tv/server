# App Orchestrator Component

This component owns the application FSM and coordinates the high-level flow.

## Responsibilities

- Listen for `TORRENT:FILE_DETAILS_READY` and start processing by emitting `LOADING:PROCESS_PLAYBACK`.
- Track FSM transitions (`IDLE`, `PROCESSING`, `PLAYING`, `ERROR`).
- React to loading outcomes:
  - `LOADING:PLAYBACK_READY` -> show player.
  - `LOADING:PLAYBACK_FAILED` -> show error.
- Handle `APP:RESET_TO_PICKER` by returning FSM to `IDLE`.
- Keep orchestration event-only; this module must not mutate view DOM directly.

## State Machine

```mermaid
stateDiagram-v2
  [*] --> IDLE
  IDLE --> PROCESSING: TORRENT:FILE_DETAILS_READY
  PROCESSING --> PLAYING: LOADING:PLAYBACK_READY
  PROCESSING --> ERROR: LOADING:PLAYBACK_FAILED
  PROCESSING --> IDLE: APP:RESET_TO_PICKER
  PLAYING --> PROCESSING: TORRENT:FILE_DETAILS_READY
  PLAYING --> ERROR: LOADING:PLAYBACK_FAILED
  PLAYING --> IDLE: APP:RESET_TO_PICKER
  ERROR --> IDLE: APP:RESET_TO_PICKER
  ERROR --> PROCESSING: TORRENT:FILE_DETAILS_READY
```
