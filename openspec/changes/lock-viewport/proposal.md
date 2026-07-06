# Proposal: Lock the document viewport (app never scrolls)

## Why

On mobile, especially after landscape/portrait rotation, the page can be
scrolled: the player shifts sideways and the (supposed to be off-screen)
playlist drawer becomes reachable by hand. Cause: `overflow: clip` was set
only on `body`, while the page scroller is the root element (`html`), and
iOS browsers apply body→viewport overflow propagation unreliably. The layout
relies on a non-scrolling viewport (`#player` is intentionally wider than the
screen; the drawer is revealed by `translate`), so any viewport scroll breaks
it. This is an app, not a page — the document must always be bounded by the
screen.

## What Changes

- `overflow: clip` on BOTH `html` and `body`; `html` gets `block-size: 100%`
  and `body` a fixed `block-size: 100dvh` (was `min-block-size`, which let
  the body exceed the screen during rotation `dvh` recalculation).
- Additionally (approved separately): dark-theme text token softened from
  pure `#fff` to `#e6e6e6` to avoid halation on black; the accent stays pure
  white — slightly brighter than text, giving the monochrome palette
  hierarchy.

## Capabilities

### New Capabilities

- `app-shell`: document/viewport behaviour of the app as a whole — the
  document never scrolls, the app is always bounded by the screen.

### Modified Capabilities

- `view-theming`: dark text colour requirement refined (soft white text,
  pure white accent). Note: the `view-theming` spec currently lives in the
  unarchived `view-color-scheme` change; its delta is updated there rather
  than double-tracked here.

## Impact

- `public/css/layout.css` — html/body overflow and sizing.
- `public/css/theme.css` — dark `--view-text` value.
- `CHANGELOG.md` entry at current package.json version + 1 patch.
