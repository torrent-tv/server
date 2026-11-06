# Proposal: Solve each recurring task one way (server and page)

## Why

Part of torrent-tv/meta#279: is the same task solved the same way everywhere?
The method, the full inventory and the order are in the proxy change
`proxy/openspec/changes/one-way-per-task/design.md`. In this repository the
duplication is mostly in `public/` and `loading.js` (about 7000 lines), and in
four places the copies behave differently:

- The start gate releases the picture only on a version-1 ready forecast; the
  seek gate (`domain/picture-holds.js` `seekHoldAnswer`) releases on a missing
  or null forecast, which the proxy sends for a superseded action (#289).
- The picker's file and URL errors are dispatched to an error dialog the IDLE
  state cannot show; the magnet field's error, reported by constraint
  validation, shows (#290).
- Retryability of one proxy refusal is decided six ways, so one refusal can
  offer Retry on one path and not on another (#299).
- A base32 or btmh magnet is accepted by the picker but not by
  `#currentInfoHash`, so the magnet path skips the holder preference that the
  .torrent path has (#298).

## What Changes

| # | Task | Owner after the change |
|---|------|------------------------|
| #288 | the wait shown to the viewer | `playbackReadiness` + `WaitingModel` only; dead estimate and progress removed |
| #289 | release the picture from the forecast | `public/domain/readiness-gate.js` |
| #290 | report a picker input error | constraint validation on the input |
| #297 | copy or transcode each track | `public/domain/transcode-plan.js`; dead HTTP transport removed |
| #298 | open a source; parse a magnet | one `#openSource`; `public/domain/magnet.js` |
| #299 | read a proxy refusal; poll while pending; delay and abort | `public/domain/proxy-answer.js`, `public/shared/` |
| #312 | WebRTC signalling handshake | one signalling session for both peers |
| #313 | contract literals; proxy registration | `public/shared/proxy-contract.js`; tunnel-only registration |
| #314 | dialogs, panels, `[evt]` log, hex, player colours | `public/shared/`, `css/theme.css` tokens |
| #315 | test DOM, fetch and signalling fakes | `test/support/` |

Shared with the proxy: #281 (the unused tunnel `relay()`), #287, #300, #302,
#303, #304 (tooling).

## Capabilities

### New Capabilities

- `one-way-per-task`: each page task listed above has one owner.

### Modified Capabilities

None as a whole; #289, #290, #298 and #299 change behaviour where copies
disagreed and add `CHANGELOG.md` entries.

## Impact

`public/components/loading/loading.js` is edited by #288, #289, #297, #298 and
#299 in that order (each after the previous one is published) to avoid
conflicting edits. Changes that need the proxy ship after it.

## Non-goals

The forecast mathematics (#255-#266); designing a real ETA; BitTorrent
v2-only support end to end.
