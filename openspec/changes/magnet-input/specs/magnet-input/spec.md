# magnet-input — delta spec

## ADDED Requirements

### Requirement: Magnet links start playback through every input channel
The app SHALL accept a magnet URI via (1) the `?magnet=` URL parameter
(removed from the URL immediately), (2) pasting magnet text anywhere on the
picker (clipboard files keep priority), and (3) a text field on the picker
submitted with Enter. A non-magnet submission SHALL show a plain-language
error. `.torrent` file input is unaffected.

#### Scenario: Pasted magnet
- **WHEN** the user pastes a magnet URI on the picker
- **THEN** the loading flow starts, titled from the magnet's `dn` name when
  present

#### Scenario: Invalid input
- **WHEN** the user submits text that is not a magnet URI
- **THEN** an error explains it and the picker remains usable

### Requirement: The magnet flow rejoins the torrent flow
After the proxy returns the swarm metadata (`/api/sources/:key/files`), the
file list SHALL be normalised to the same shape the local `.torrent` parser
produces and the flow SHALL continue identically: playlist for multiple
videos, autoplay for one, subtitles/tracks/cancel/retry unchanged. A magnet
whose metadata cannot be fetched SHALL fail with an explicit
no-peers-reachable message.

#### Scenario: Multi-file magnet
- **WHEN** metadata arrives for a magnet with several videos
- **THEN** the playlist opens listing them, and selecting one plays it

#### Scenario: Dead swarm
- **WHEN** no metadata arrives within the wait budget
- **THEN** the error screen shows the no-peers message
