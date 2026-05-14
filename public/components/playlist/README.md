# Playlist Component

This component owns playlist list rendering and playlist user interactions.

## Responsibilities

- Render the list of available video files from `PLAYER:SET_MEDIA_FILES`.
- Track currently active file from `PLAYER:SET_ACTIVE_MEDIA_FILE`.
- React to `PLAYER:OPEN_PLAYLIST` / `PLAYER:CLOSE_PLAYLIST` for playlist panel visibility state.
- Emit `PLAYER:SELECT_MEDIA_FILE` when user clicks a different file in the playlist.
- If user clicks the currently active file, only close playlist without reloading playback.
- Emit `PLAYER:CLOSE_PLAYLIST` after list click handling.
- If focus is inside playlist during close, emit `PLAYER:FOCUS_PLAYLIST_TOGGLE` before making playlist inert.
- On `LOADING:SHOW`, close playlist but keep rendered file list.

## Layout Rules

- Playlist panel is a sibling of `#player__video`.
- Mobile: panel width is `80vw`.
- Desktop: panel width is content-driven with upper bounds.

## Coupling Rule

- This component must not mutate player-owned DOM (`#player__video`, player buttons) directly.
- All cross-component effects are event-driven via `public/shared/events.js`.
