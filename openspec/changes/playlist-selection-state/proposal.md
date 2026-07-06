# Proposal: Playlist selection state

## Why

When the playlist of a freshly opened torrent appears, the first row looks
selected: the drawer focuses its first button for keyboard accessibility and
the CSS paints `:focus` with the same red fill as the currently-playing row.
Nothing is playing yet, so no row must look chosen. Conversely, once the user
has picked a file, that choice must stay visibly marked until they leave for
the torrent picker.

## What Changes

- Focus styling in the playlist is visually separated from the
  currently-playing marker: focus renders as an outline, the red fill is
  reserved for `aria-current` (playing) and pointer hover.
- The currently-playing marker persists across playback errors and drawer
  close/open; it is cleared only on return to the torrent picker or when a new
  torrent's file list replaces the playlist (the error-screen part shipped in
  0.8.27 as a bug fix; this change encodes it as a requirement).

## Capabilities

### New Capabilities

<!-- none -->

### Modified Capabilities

- `player-ui`: the "Playlist integration" requirement gains selection-state
  rules — no default selection in a fresh playlist, persistence of the
  playing marker, and focus styling distinct from selection.

## Impact

- `public/components/playlist/playlist.css` — focus vs selection styling.
- No JS changes expected (index reset/persistence semantics already match
  after 0.8.27).
- `CHANGELOG.md` entry at current package.json version + 1 patch.
