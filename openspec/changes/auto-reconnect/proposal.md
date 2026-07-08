# Proposal: Automatic reconnect after a mid-playback connection loss

## Why

Field evidence (mobile tester session, proxy logs + screen recordings,
2026-07-08): on cellular networks the WebRTC data channel dies every
1–2 minutes (the NAT rebinds the phone's external port; the single UDP path
has no recovery). Today every loss ends in the error screen with a manual
Retry button — the viewer must notice, click, and wait through a full
restart: proxy re-selection, a fresh RTCPeerConnection, and a seek back.
One reconnect attempt in the logs also sat in ICE for 39 seconds before
failing. "Плохо работает" on mobile is exactly this loop.

The transport loss is already detected (`onConnectionLost`, shipped in
0.8.34) and the resume snapshot already works (manual Retry). What is
missing is only the automation between the two: try to get a new transport
and resume WITHOUT the user, and fail fast instead of waiting out long
timeouts. The just-shipped client-log correlation (0.8.55) makes every
reconnect cycle visible in the server log for field verification.

## What Changes

- **On loss during playback the app auto-reconnects instead of showing the
  error screen.** The loading view appears with a "reconnecting" status and
  the Cancel button; the error screen (with the manual Retry) is shown only
  after all automatic attempts fail — the current behaviour becomes the
  last resort, not the first response.
- **Reconnect prefers the proxy that was just working.** Attempt 1: same
  proxy, immediately, with a short 10 s connect timeout. Attempt 2: same
  proxy again after a 2 s pause. Attempt 3: full standard re-selection
  (possibly a different pool node). No permission UI can appear during
  same-proxy attempts (the candidate policy of the successful connection is
  reused).
- **Offline-aware**: when `navigator.onLine` is false (mobile network
  transition — the exact field case), the loop waits for the `online` event
  (bounded) before burning an attempt.
- **Loop guard**: if playback keeps dying right after each recovery, after
  3 consecutive loss→recover cycles the error screen is shown. The cycle
  counter resets once playback has survived 30 s.
- **Every attempt is logged** with the `[torrent-tv]` prefix, so reconnect
  cycles arrive in the server log via the client-log pipeline (0.8.55) and
  are greppable next to the proxy's `[webrtc] Session <id>` lines.

Explicitly NOT in this change (see design.md for why): WebRTC ICE restart
on the existing connection (needs proxy-side renegotiation support), a
seamless transport swap under a live player (deeper refactor), and initial
connect-timeout tuning.

## Capabilities

### Modified Capabilities

- `playback-recovery`: loss now triggers automatic recovery; the error
  screen + manual Retry become the fallback after automation fails.

## Impact

- `public/components/loading/loading.js` — auto-reconnect loop in the loss
  handler; factored resume; proxy adoption helper; constants; messages.
- `public/domain/webrtc-proxy.js` — three read-only getters (proxyId,
  proxyLocalPort, allowsPrivateCandidates) so the app can rebuild the same
  connection.
- `public/components/proxy-selector/proxy-selector.js` — `reconnectTo`
  (build + connect a WebRtcProxy from a saved descriptor).
- Server-only release (0.8.56); NO proxy or ha-addon change.
