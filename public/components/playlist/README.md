# Playlist Component

This component owns playlist list rendering and playlist user interactions.

## Responsibilities

- Render the available video files from `PLAYER:SET_MEDIA_FILES`.
- Group files from one folder into a `<details>` section when the folder contains a proper subset of the files.
- Open the group containing the active file and retain groups the viewer opened.
- Track the active file from `PLAYER:SET_ACTIVE_MEDIA_FILE`.
- Show the list only when `PLAYER:PANEL_CHANGED` selects `playlist`.
- Emit `PLAYER:SELECT_MEDIA_FILE` when the viewer selects a different file.
- Close the panel after selecting a file; selecting the active file closes it without reloading playback.
- Close the list on `LOADING:SHOW` while retaining its rendered contents.

## Layout

The playlist list is one of two mutually exclusive contents of `#player__panel`,
beside `#player__controller`. The player owns the panel width, slide and focus
restoration.

## Coupling

This component does not mutate player-owned DOM such as the video element or
player controls. Cross-component effects use events from `public/shared/events.js`.
