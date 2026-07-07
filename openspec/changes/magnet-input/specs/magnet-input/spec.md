# magnet-input — delta spec

## ADDED Requirements

### Requirement: Magnet links start playback through every input channel
The app SHALL accept a magnet URI via (1) the `?magnet=` URL parameter
(removed from the URL immediately), (2) pasting magnet text anywhere on the
picker (clipboard files keep priority; unrecognised text is silently
ignored), and (3) a text field on the picker with a visible submit button whose label
names the action. Every channel SHALL route through the field and its form,
and the field SHALL clear once the flow starts — consistent with the file
input. A field value that is
a COMPLETE magnet URI (`xt=urn:btih/btmh` hash present) SHALL auto-start
the flow on input, so pasting into the field needs no further action. An
invalid explicit submission SHALL show an inline field validation message
(Validation API) — never a separate error screen. `.torrent` file input is
unaffected.

#### Scenario: Pasted magnet
- **WHEN** the user pastes a complete magnet URI anywhere on the picker
- **THEN** the field shows it and the loading flow starts immediately,
  titled from the magnet's `dn` name when present

#### Scenario: Invalid explicit submission
- **WHEN** the user submits text that is not a magnet URI
- **THEN** an inline validation message appears at the field and the picker
  stays as it was

#### Scenario: Partial manual typing
- **WHEN** the field contains an incomplete magnet prefix (no hash yet)
- **THEN** nothing auto-starts

### Requirement: The magnet flow rejoins the torrent flow
The magnet flow SHALL poll for the swarm metadata rather than fail on the
first miss: the proxy returns `pending` while the fetch continues in the
background, and the browser SHALL keep polling (showing a metadata-fetch
status, cancellable) until the file list arrives or a wall-clock deadline is
reached. Once metadata arrives the file list SHALL be normalised to the same
shape the local torrent parser produces, then the playlist opens for
multiple videos, a single video autoplays, and subtitles, tracks, cancel and
retry behave unchanged. Only after the deadline SHALL it fail with an
explicit no-peers-reachable message.

#### Scenario: Metadata arrives after a short delay
- **WHEN** the metadata is not ready on the first poll but arrives moments
  later
- **THEN** playback proceeds on a later poll without the user retrying

#### Scenario: Multi-file magnet
- **WHEN** metadata arrives for a magnet with several videos
- **THEN** the playlist opens listing them, and selecting one plays it

#### Scenario: Dead swarm
- **WHEN** no metadata arrives before the deadline
- **THEN** the error screen shows the no-peers message
