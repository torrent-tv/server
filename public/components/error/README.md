# Error Component

This component is the dedicated error presentation layer.

## Responsibilities

- Use native `<dialog>` modal behavior for visibility (`showModal` / `close`) with inert-safe toggling.

## State Machine

Visibility is derived from the application state, not commanded: see
`public/domain/app-state.js` for the machine and the outputs, and
`research/state-machine-2026-08-08.md` in the meta repo for the graph and the
reasoning. A per-component state diagram would only duplicate it, and the two
would drift.
