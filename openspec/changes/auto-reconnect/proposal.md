# Proposal: Automatic reconnect after a mid-playback connection loss

## Why

Field evidence (mobile tester session, proxy logs + screen recordings,
2026-07-08): on cellular networks the WebRTC data channel dies every
1–2 minutes (the NAT rebinds the phone's external port; the single UDP path
has no recovery). Today every loss ends in the error screen with a manual
Retry button — the viewer must notice, click, and wait through a full
restart: proxy re-selection, a fresh RTCPeerConnection, player rebuild and
a seek back. One reconnect attempt in the logs also sat in ICE for
39 seconds before failing. "Плохо работает" on mobile is exactly this loop.

The transport loss is already detected (`onConnectionLost`, 0.8.34) and the
resume snapshot already works (manual Retry). Everything the player needs
also survives the loss on the proxy side: the ffmpeg HLS session lives
~120 s and the torrent data ~300 s after a viewer vanishes — the same proxy
can resume serving the same playlist over a fresh channel. What is missing
is the automation in between, and it should not tear the player down at
all.

## What Changes

Three recovery levels, tried in order (design.md is normative):

- **Level 1 — seamless (same proxy).** On loss the player is NOT torn
  down: `hls.stopLoad()` freezes fetching while playback continues from
  buffer; a new connection to the same proxy is built in the background
  (short 10 s timeout, one 2 s-backoff repeat, no permission UI possible);
  the transport is swapped under the live player and `startLoad()`
  resumes. The viewer sees nothing unless the buffer runs dry first. This
  requires one architectural fix that is overdue anyway: the HLS loader
  starts depending on `ProxyTransport` (which gains a replaceable inner
  proxy) instead of holding the raw `WebRtcProxy`.
- **Level 2 — automated rebuild (different proxy, or Level 1 failed).**
  The existing manual-Retry flow (re-selection via the standard two-stage
  acquire, player rebuild, server-side seek to the captured position) runs
  automatically, with the loading view visible.
- **Level 3 — the error screen with manual Retry**, exactly today's
  behaviour, only after all automatic attempts fail.

Plus: offline-awareness (when `navigator.onLine` is false — the mobile
network transition case — the loop waits for the `online` event, bounded,
before spending an attempt), a loop guard (3 consecutive loss→recover
cycles → error screen; 30 s of healthy playback resets the count), and
observability (every attempt logged on the `[torrent-tv]` channel →
delivered by the 0.8.55 client-log pipeline, greppable next to the proxy's
`[webrtc] Session <id>` lines).

**WebRTC ICE restart was evaluated and is not available at any effort level
within this project**: libjuice (the ICE layer under the proxy's
libdatachannel) cannot restart ICE at all — verified upstream
(libdatachannel#545 open; PR #1568 closed unmerged for exactly this
reason; node-datachannel's `restartIce()` throws "Not implemented").
Details and the revisit condition in design.md. This is a library fact,
not a release-logistics choice — proxy/addon releases are routine and
remain on the table if verification shows the proxy needs a lifecycle
adjustment.

## Capabilities

### Modified Capabilities

- `playback-recovery`: loss now triggers automatic, preferably seamless
  recovery; the error screen + manual Retry become the last resort.

## Impact

- `public/components/loading/loading.js` — auto-reconnect loop; factored
  resume; proxy adoption + descriptor capture; constants; messages.
- `public/domain/proxy-transport.js` — replaceable inner WebRTC proxy
  (`replaceWebRtcProxy`).
- `public/domain/webrtc-hls-loader.js` — depends on the transport instead
  of the raw proxy (single swap point).
- `public/domain/hls-player.js` — expose `stopLoad`/`startLoad`.
- `public/domain/webrtc-proxy.js` — three read-only getters.
- `public/components/proxy-selector/proxy-selector.js` — `reconnectTo`.
- Expected server-only (0.8.56). If proxy-side lifecycle verification
  (tasks 1.4) reveals a needed adjustment, the proxy change is made and
  released with an addon bump per the standard rules.
