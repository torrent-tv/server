# Design: Connection reliability

## Context

Reachability (`reachable`, endpoint external IP) is already collected by the
dial-back prober and stored per proxy; the health API simply does not expose
it, and the selector does not use it. The WebRTC transport rejects pending
requests when the channel closes but tells nobody; after `PLAYBACK_READY`
nothing watches the transport at all. `session.clear()` (run by the error
screen) wipes `session.current`, which a retry needs.

## Goals / Non-Goals

**Goals:** reachable-first selection with graceful fallback; explicit
connection-lost UX with one-tap resume.

**Non-Goals:** automatic (no-user-action) reconnect — explicitly a later
step; multi-endpoint racing (roadmap step 7); UDP-specific reachability
probing.

## Decisions

1. **Preference, not filter.** `reachable=false` means "inbound TCP probe
   failed", not "WebRTC cannot connect" (hole punching is
   outbound-initiated on both sides). Filtering would empty small pools and
   discard connectable nodes; preferring keeps both properties.
2. **Browser public IP from `CF-Connecting-IP`.** The site is always behind
   Cloudflare, which sets it authoritatively; `X-Forwarded-For[0]`/socket
   address are dev-mode fallbacks. Compared against the proxy's
   UPnP-reported external IP already stored with the probe result.
3. **Loss detection in the transport, policy in loading.** `WebRtcProxy`
   gets an `onConnectionLost` callback (fired once, only after a successful
   connect, suppressed by our own `close()` — a `#closedByUser` flag).
   `loading.js` decides what it means: with an active file it snapshots
   `{session.current, fileIndex, currentTime}` BEFORE dispatching
   `PLAYBACK_FAILED { canRetry: true }`, because the error flow's
   `#stopPlayback()` clears the session.
4. **Retry = replay the existing switch path.** `APP:RETRY_PLAYBACK`
   restores `session.current` from the snapshot and calls the same
   `#switchToVideoFile()` used by the playlist, then seeks to the captured
   position after playback is ready — the server-side seek machinery treats
   it like a user seek. No new playback path to maintain; the proxy is
   re-selected by the normal selector (a different node may pick up).
5. **Error screen keeps its one-navigation-button rule**; Retry is an
   additional, primary action shown only for `canRetry` errors.

## Risks / Trade-offs

- [Seek-after-ready briefly buffers at 0 before jumping] → acceptable for
  v1 (retry is rare); plumbing startPosition into session creation is a
  later optimisation.
- [Same-network detection misses multi-IP households (CGNAT egress
  differences)] → sameNetwork is an additive preference signal only; a miss
  degrades to the normal scored selection.
