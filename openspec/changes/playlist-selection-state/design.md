# Design: Playlist selection state

## Context

The drawer focuses its first button on open (keyboard accessibility —
`playlist.js #onPlaylistOpen`). `playlist.css` styles `:hover` and focus with
the same red fill used for the `aria-current` row, so on a fresh torrent the
focused first row reads as "selected". The selection index itself already has
the right lifecycle after 0.8.27: `-1` on new media files, kept on errors,
cleared on `APP:RESET_TO_PICKER`.

## Goals / Non-Goals

**Goals:** focus ≠ selection visually; no JS behaviour change; keep the
programmatic focus (keyboard users need it).

**Non-Goals:** changing selection lifecycle logic (already correct); focus
management redesign; touch-specific focus suppression.

## Decisions

1. **CSS-only fix.** `:focus-visible` gets an accent outline drawn inside the
   row (`outline-offset: -2px` so it is visible despite `overflow: clip` on
   the list); the red fill remains only on `:hover` and `[aria-current]`.
   Alternative — not focusing the first button on open — rejected: it breaks
   keyboard navigation into the drawer.
2. **No new state.** The `-1` index semantics from 0.8.27 already satisfy the
   persistence requirement; the spec delta encodes it so it cannot regress
   silently.

## Risks / Trade-offs

- [Programmatic focus may not match `:focus-visible` in some browsers, hiding
  the ring for keyboard users] → acceptable: arrowing/tabbing re-triggers
  focus-visible; the fresh-playlist case is the one we must not mislead.
