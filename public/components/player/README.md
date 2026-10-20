# Player Component

This component owns the visible video area, player menu controls, and the single side-panel state shared by the playlist and chapters.

## Responsibilities

- Emit `PLAYER:READY` with `videoElement`.
- Re-emit `PLAYER:READY` on `PLAYER:REQUEST_READY`.
- Reset the media element on `APP:RESET_TO_PICKER`.
- Stop and clear the media element on `ERROR:SHOW`.
- Handle panel state:
  - `PLAYER:OPEN_PLAYLIST` / `PLAYER:CLOSE_PLAYLIST` preserve playback-flow entry points.
  - `PLAYER:SET_PANEL` selects `playlist`, `chapters` or `null`; publish `PLAYER:PANEL_CHANGED` for the list owners.
  - Forward `PLAYER:REQUEST_SEEK` through the media controller as `mediaseekrequest`.
- Emit `PLAYER:SET_PANEL` from the playlist and chapters controls.
- Emit `APP:RESET_TO_PICKER` from the reset button.

## State Machine

Visibility is derived from the application state, not commanded: see
`public/domain/app-state.js` for the machine and `research/state-machine-2026-08-08.md`
in the meta repo for the graph and reasoning. The side-panel selection is
presentation state and does not add an application control state.
