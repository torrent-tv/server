# Proposal: Cancel button on the loading screen (HIGH priority — next up)

## Why

The loading screen (metadata download, transcode warm-up, prebuffer) has no
way out: no close/cancel control exists, so when loading hangs or the user
changes their mind, the only options are waiting out a timeout (up to
minutes) or reloading the page. Seen in the field on 2026-07-07: a stalled
"Data channel request timed out" flow left the viewer stuck watching the
spinner.

## What Changes

- A cancel control on the loading view (styled with the shared theme
  tokens), always available while loading is in progress.
- Cancel aborts the in-flight flow (the abort-error plumbing and
  `session.abortPendingRequests()` already exist — loading treats abort
  errors as silent) and returns to the playlist for multi-file torrents or
  to the torrent picker otherwise, releasing the transport and any
  transcode session (the existing `#stopPlayback` path).
- No timeout behaviour changes; cancel is purely user-initiated.

## Capabilities

### New Capabilities

- `loading-cancel`: user-initiated abort of the loading flow.

### Modified Capabilities

<!-- none -->

## Impact

- `public/index.html`, `components/loading/loading.css` — cancel control.
- `components/loading/loading.js` — abort wiring; `torrent-tv.js` state
  transition (PROCESSING → IDLE/PLAYING).
- `CHANGELOG.md` at current version + 1 patch.

## Priority

HIGH — first in the queue (explicitly prioritised by the owner,
2026-07-07).
