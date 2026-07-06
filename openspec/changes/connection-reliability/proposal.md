# Proposal: Connection reliability — reachable-first selection and retry

## Why

Two failure modes cost viewers real minutes today:

1. The proxy selector scores candidates by CPU/RAM/RTT only, ignoring the
   dial-back reachability the server has been collecting since 0.8.22 — a
   remote viewer can be handed an unreachable node and waits out a 30 s
   WebRTC timeout while a reachable one sat in the list.
2. When the data channel dies mid-playback (proxy restart, network change),
   playback silently stalls; the viewer's only path is reloading and
   starting from zero.

## What Changes

- **Health API** (`/api/proxy-clients/health`) returns two new per-proxy
  fields: `reachable` (dial-back probe result; null = not probed) and
  `sameNetwork` (the requesting browser's public IP — `CF-Connecting-IP` —
  equals the proxy's reported external IP).
- **Selector preference, not filter**: candidates with
  `reachable || sameNetwork` are preferred; when none qualify, ALL
  candidates stay eligible (WebRTC hole punching can succeed where the
  inbound-TCP probe fails — probe false does not prove unreachability).
- **Connection-loss detection**: the WebRTC transport exposes a
  connection-lost callback (channel closed / connection failed after a
  successful connect, and not by our own `close()`).
- **Retry with resume**: on loss during playback the app captures the
  session snapshot, file index and playback position, shows the error
  screen with a "Retry" action; Retry reconnects (possibly to a different
  proxy), restarts the same file and seeks back to the captured position.

## Capabilities

### New Capabilities

- `proxy-selection`: how the browser picks a proxy from the pool.
- `playback-recovery`: behaviour when the proxy connection is lost.

### Modified Capabilities

<!-- none -->

## Impact

- `routes/api/proxy-clients/health/get.js` — reachable/sameNetwork fields.
- `public/components/proxy-selector/proxy-selector.js` — preference logic.
- `public/domain/webrtc-proxy.js` — onConnectionLost callback.
- `public/components/loading/loading.js` — loss handler, resume snapshot,
  retry flow.
- `public/components/error/error.js`, `index.html` — Retry action.
- `public/components/torrent-tv/torrent-tv.js` — canRetry passthrough,
  ERROR→PROCESSING transition on retry.
- `public/shared/events.js` — `APP:RETRY_PLAYBACK`.
- `CHANGELOG.md` at current version + 1 patch.
