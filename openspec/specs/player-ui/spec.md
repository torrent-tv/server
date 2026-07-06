# player-ui Specification

## Purpose
TBD - created by archiving change adopt-media-chrome-player. Update Purpose after archive.
## Requirements
### Requirement: Unified player controls
The player SHALL present a media-chrome control bar — play/pause, seek range,
time display, mute/volume, fullscreen — on every playback path (hls.js/MSE and
native HLS). The native `controls` attribute SHALL be removed from the video
element so controls never double up.

#### Scenario: Controls on the MSE path
- **WHEN** playback starts through hls.js with the WebRTC data-channel loader
- **THEN** the media-chrome control bar is shown and native controls are not

#### Scenario: Controls on the native-HLS path
- **WHEN** playback starts via native HLS (Safari without MSE)
- **THEN** the same media-chrome control bar is shown and play/pause/seek
  operate on the video element

### Requirement: Subtitle selection menu
The player SHALL provide a captions menu listing every attached text track
with its label and language, plus an "Off" state. The menu SHALL reflect the
`<track>` elements produced by the existing external-subtitle pipeline without
changes to that pipeline.

#### Scenario: Torrent with external subtitles
- **WHEN** a video with matched external subtitle files starts playing
- **THEN** the captions menu lists each track (label including language and
  release group) and selecting one renders its cues

#### Scenario: Subtitles off
- **WHEN** the user selects "Off" in the captions menu
- **THEN** no subtitle cues are rendered

### Requirement: Close action
The player SHALL show a close button in the top chrome. Closing SHALL stop
playback, release playback resources (pause the video, detach the source) and
return the user to the torrent picker.

#### Scenario: Close during playback
- **WHEN** the user activates close during playback
- **THEN** playback stops and the torrent picker is shown

### Requirement: Playlist integration
The playlist SHALL remain a custom component, SHALL be reachable from the
player control bar for multi-file torrents, and SHALL use the same theme
tokens as the player controls. Selecting another file SHALL switch playback to
that file. While the playlist drawer is open, a click or tap on the player
surface outside the drawer SHALL close it without toggling play/pause.

#### Scenario: Switching files from the playlist
- **WHEN** the user opens the playlist from the control bar and selects a
  different video file
- **THEN** playback of the selected file starts and the subtitle tracks of the
  previous file are cleared

#### Scenario: Click outside the open playlist
- **WHEN** the playlist drawer is open and the user clicks the video area
- **THEN** the drawer closes and the playback state (playing/paused) does not
  change

### Requirement: Light and dark themes
The player UI (controls, menus, playlist, close button) SHALL follow the
system colour scheme via `prefers-color-scheme`, using media-chrome CSS
variables as the single set of design tokens.

#### Scenario: Dark scheme
- **WHEN** the operating system colour scheme is dark
- **THEN** the player controls and playlist render with the dark token set

### Requirement: Settings menu extension points
The player settings menu SHALL support app-defined menu items. Audio-track and
quality items SHALL exist as hidden extension points in this change and SHALL
NOT be visible until their backing features are implemented.

#### Scenario: Extension points in this release
- **WHEN** the settings menu is opened
- **THEN** no audio-track or quality entries are visible

### Requirement: Non-fatal errors stay off-screen
The player UI SHALL NOT surface non-fatal playback errors (e.g. hls.js
`bufferStalledError` during warm-up) on screen; they remain console-only.

#### Scenario: Transient stall during warm-up
- **WHEN** hls.js reports a non-fatal buffering error during playback start
- **THEN** no on-screen status or error element is shown

