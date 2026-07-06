# player-ui — delta spec

## MODIFIED Requirements

### Requirement: Playlist integration
The playlist SHALL remain a custom component, SHALL be reachable from the
player control bar for multi-file torrents, and SHALL use the same theme
tokens as the player controls. Selecting another file SHALL switch playback to
that file. While the playlist drawer is open, a click or tap on the player
surface outside the drawer SHALL close it without toggling play/pause.

The playlist SHALL mark exactly one row as current — the file the user chose
for playback — and SHALL NOT mark any row when no file has been chosen yet.
The current marker SHALL persist across playback errors and drawer
close/open, and SHALL be cleared only when the user returns to the torrent
picker or when a new torrent's files replace the list. Keyboard focus SHALL
be visually distinct from the current marker (focus MUST NOT reuse the
current-row fill).

#### Scenario: Switching files from the playlist
- **WHEN** the user opens the playlist from the control bar and selects a
  different video file
- **THEN** playback of the selected file starts and the subtitle tracks of the
  previous file are cleared

#### Scenario: Click outside the open playlist
- **WHEN** the playlist drawer is open and the user clicks the video area
- **THEN** the drawer closes and the playback state (playing/paused) does not
  change

#### Scenario: Fresh torrent playlist has no selection
- **WHEN** a multi-file torrent is opened and its playlist is shown before any
  file was chosen
- **THEN** no playlist row is marked as current, including the row that
  receives keyboard focus

#### Scenario: Selection survives a playback error
- **WHEN** a chosen file fails to play and the user returns to the playlist
  from the error screen
- **THEN** the previously chosen file is still marked as current

#### Scenario: Selection cleared on returning to the picker
- **WHEN** the user returns to the torrent picker
- **THEN** the playlist selection is cleared and a subsequently opened torrent
  starts with no row marked
