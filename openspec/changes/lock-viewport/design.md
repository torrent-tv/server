# Design: Lock the document viewport

## Context

`layout.css` had `overflow: clip` on `body` only, relying on body→viewport
overflow propagation. The propagation is spec-compliant on desktop but
unreliable on iOS, and the page scroller is the root element. The player's
slide-drawer layout (`#player` wider than the viewport, revealed by
`translate`) assumes a non-scrolling viewport.

## Goals / Non-Goals

**Goals:** the document can never scroll or hold a scroll offset, on any
browser, in any orientation.

**Non-Goals:** changing the player drawer mechanism; `position: fixed` body
hacks (not needed once the root is clipped).

## Decisions

1. **Clip the root, not just the body.** `overflow: clip` on `html` removes
   the page scroller entirely (clip, unlike hidden, creates no scroll
   container), so there is nothing to get offset during rotation. Body keeps
   clip too for defence in depth.
2. **Fixed heights.** `html { block-size: 100% }`,
   `body { block-size: 100dvh }` (was `min-block-size`) — the body can never
   exceed the screen while `dvh` recalculates during rotation.

## Risks / Trade-offs

- [Content taller than the screen becomes unreachable] → intended: every
  view is screen-bounded by design; scrollable areas (playlist) have their
  own overflow containers.
