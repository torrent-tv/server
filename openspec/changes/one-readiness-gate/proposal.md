# Proposal: One readiness verdict at start and after a seek (torrent-tv/meta#289)

## Why

The page reads the proxy's forecast (`playbackReadiness`) in three places with
three different rules:

| Place | missing / `null` | version ≠ 1 | answer asked before the seek was reported | `media-continuity-unavailable` | subtitle hold |
|---|---|---|---|---|---|
| start, `loading.js` `#waitForPrebuffer` | wait | wait | not checked | throws (ERROR) | yes |
| seek, `domain/picture-holds.js` `seekHoldAnswer` | **release** | **release** | stale | not checked (waits) | no |
| overlay, `components/waiting/waiting.js` | — | own `version !== 1` check | — | — | — |

The proxy answers `playbackReadiness: null` when the forecast it was computing
belongs to an action that has been superseded (proxy
`services/server/ViewerRequests.js`, `#playbackReadinessFor` returns `null`
when the request no longer owns the progress), and the contract
(`proxy/docs/browser-proxy-contract.md`) says a missing or unsupported version
does not authorise playback. After a seek the seek gate reads that `null` as
"release": the viewer sees the waiting overlay drop and then a stall
(`STALLED`) right after it.

For the viewer: after a seek the picture starts only when the proxy says it can
keep playing, the same promise the first start already keeps. For us: one rule
in one pure, tested module instead of three copies that drift.

## What changes

- New `public/domain/readiness-gate.js` exporting `readinessVerdict`, the only
  reader of `playbackReadiness.version` / `ready` in `public/`.
- `#waitForPrebuffer` and `#holdSeekUntilReady` in `loading.js` decide only
  through it. `seekHoldAnswer` is removed from `picture-holds.js`
  (`nextSeekHoldAsk` and `PictureHolds` stay).
- After a seek, `media-continuity-unavailable` fails playback the way it does
  at start, instead of holding forever.
- `waiting.js` takes "this proxy's forecast version is unsupported" from the
  verdict's reason instead of its own `version !== 1`.
- No proxy change: the proxy already sends what the contract says.

## Out of scope

- The forecast mathematics (#255–#266) and the proxy.
- `public/domain/chapter-metadata.js` `answer?.version !== 1`: that is the
  chapter answer's own contract version, not `playbackReadiness`; it stays.
- The overlay's texts and `WaitingModel` (#288 already made them the one owner
  of the wait shown).
- Polling cadences (`nextSeekHoldAsk`, the 250 ms / 1.5 s start loop) and the
  subtitle-start rule (`subtitleStartHold`) — called as today, not changed.
