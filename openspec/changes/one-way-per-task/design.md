# Design: Solve each recurring task one way (server and page)

Line numbers at server `f0cccb5` (0.66.27); `origin/main` moved `loading.js`,
`torrent-session.js` and `net-report.js` a little. Each sub-issue holds its
evidence, steps and acceptance criteria. Method, refuted claims and the
cross-repository order: `proxy/openspec/changes/one-way-per-task/design.md`.

## Order

`loading.js` chain: #288 → #289 → #297 → #298 → #299. Then #314 (after #298),
#315 (after #289, #299), #313 (after #299, #312 and the proxy's #281).
#290 and #312 have no prerequisite.

## Checked, not duplication

- `/health` and `/healthz`: different consumers (Docker and slot checks use
  `/healthz`, the disk check `/health`); both stay, sharing one body function
  only if either is touched.
- Route input validation and error replies are written one way.
- Signalling relay (`services/signal-hub.js` + tunnel `signal`), proxy choice
  and scoring (`services/proxy-choice.js`, `proxy-candidates.js`) and event
  names (`shared/events.js`) have one owner each.
- `store/proxy-clients-store.js` (identity, reachability) and
  `services/proxy-tunnel-server.js` (socket, metrics) are a deliberate split
  joined once in `proxyCandidates`; only the two registration writers are a
  duplicate (#313).
- File-kind classification and the quality ladder are owned by the proxy.
- `waiting-text.js` formats a wait, `chapter-navigation.js` a film position:
  different quantities.
- `release-hints.js` (page) and `release-name.js` (server) produce different
  outputs.
- No `px` in CSS.
