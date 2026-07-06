# Proposal: OS-driven light/dark theme for the app views

## Why

The app views (torrent picker, loading, error) are hard-coded light —
white backdrop, black text, red accent — regardless of the OS/browser colour
scheme. The player already follows `prefers-color-scheme`; the surrounding
views should too, and a dark room is the natural environment for a video app.

## What Changes

- A shared token set (`css/theme.css`, applied on `:root` with
  `color-scheme: light dark` and the `light-dark()` CSS function) defines
  view background, text, muted text, accent and progress-rail colours.
- Light theme keeps the current palette (white / black / `#c00` accent).
- Dark theme per the agreed formula: background black, black text becomes
  white, and the red accent also becomes white (monochrome white-on-black).
  Switching the dark accent to the player's red later is a one-token change.
- The three view stylesheets consume the tokens instead of literals.
- The player keeps its own token set (already scheme-aware).

## Capabilities

### New Capabilities

- `view-theming`: colour-scheme behaviour of the non-player views (picker,
  loading, error) — token source, light palette, dark palette.

### Modified Capabilities

<!-- none — player-ui theming is unchanged -->

## Impact

- New `public/css/theme.css` + `<link>` in `index.html`.
- `components/torrent/torrent.css`, `components/loading/loading.css`,
  `components/error/error.css` — literals → tokens.
- `CHANGELOG.md` entry at current package.json version + 1 patch.
- Requires `light-dark()` support (all evergreen browsers since 2024; older
  browsers fall back to UA defaults — acceptable, the app already requires a
  modern browser for playback).
