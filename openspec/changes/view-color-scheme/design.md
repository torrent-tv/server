# Design: OS-driven light/dark theme for the app views

## Context

Views hard-code `#fff` backdrops, `#000` text and the `#c00` accent. The
player already themes itself via `prefers-color-scheme` media queries scoped
on `#player`.

## Goals / Non-Goals

**Goals:** automatic scheme switching; one token source; UA surfaces
(dialog, form controls) adapt too.

**Non-Goals:** manual theme toggle; restyling the player (has its own
tokens); supporting browsers without `light-dark()`.

## Decisions

1. **`light-dark()` + `color-scheme: light dark` on `:root`** instead of
   duplicated `@media (prefers-color-scheme)` blocks: one declaration per
   token, and `color-scheme` alone fixes UA-rendered parts that media
   queries cannot reach. This is the modern, compact form; the player's
   media-query approach predates it and stays as-is.
2. **Dark palette is monochrome** (accent = white) per the agreed formula.
   The alternative — reusing the player's dark palette (`#141416`, red
   accent) — was considered; kept as a one-token switch if the monochrome
   look does not hold up.
3. **`::backdrop` uses the same custom properties** — custom-property
   inheritance into `::backdrop` is supported by evergreen browsers
   (Chrome 122+, Firefox 120+, Safari 17.4+), same support class as
   `light-dark()` itself.
4. **Hover tints derive from `currentColor`**
   (`color-mix(in srgb, currentColor 8%, transparent)`) so they need no
   scheme-specific literals.

## Risks / Trade-offs

- [Older browsers ignore `light-dark()` and lose those declarations] →
  they fall back to UA colours; playback already requires a modern browser.
