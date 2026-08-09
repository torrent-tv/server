# App Orchestrator Component

This component owns the application FSM and coordinates the high-level flow.

## Responsibilities

- Listen for `TORRENT:FILE_DETAILS_READY` and start processing by emitting `LOADING:PROCESS_PLAYBACK`.
- Drive the application state machine (`public/domain/app-state.js`) and
  announce every state it reaches as `APP:STATE_CHANGED`.
- React to loading outcomes:
  - `LOADING:PLAYBACK_READY` -> show player.
  - `LOADING:PLAYBACK_FAILED` -> show error.
- Handle `APP:RESET_TO_PICKER` by returning FSM to `IDLE`.
- Keep orchestration event-only; this module must not mutate view DOM directly.

## State Machine

Visibility is derived from the application state, not commanded: see
`public/domain/app-state.js` for the machine and the outputs, and
`research/state-machine-2026-08-08.md` in the meta repo for the graph and the
reasoning. A per-component state diagram would only duplicate it, and the two
would drift.
