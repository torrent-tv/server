# Proposal: Bottleneck diagnosis (foundation for the realtime budget)

## Why

The realtime transcode budget must react to the RIGHT constraint: a naive
"encoder slow → lower resolution" is wrong (and needlessly degrades quality)
when the real limit is the torrent download, the delivery link, or the
client's own decode. So before the budget, playback needs to know WHY it is
struggling. This ships the first, client-side layer of that diagnosis.

## What Changes

- During playback the browser periodically classifies the bottleneck from
  client-visible symptoms and logs it as `[bottleneck]` (forwarded to the
  server log via the existing client logger for field analysis):
  - **client-decode** — dropped-frame ratio high while the buffer holds
    (the viewer's device can't decode fast enough).
  - **upstream** — the forward buffer is draining toward empty (limited by
    proxy CPU, proxy download, or delivery — these are split later by the
    budget using the proxy's own `speed`/download signals).
  - **ok** — buffer healthy, few dropped frames.
- No proxy change — the proxy already exposes `speed` (`/progress`) and
  download rate (`/stats`); the upstream split is added with the budget.

## Capabilities

### New Capabilities

- `bottleneck-diagnosis`: classify why playback is limited, from client
  symptoms now and proxy signals later.

### Modified Capabilities

<!-- none -->

## Impact

- `public/components/loading/loading.js` — the existing playback-diagnostics
  tick now classifies and logs the bottleneck.
- Client-only; server release, no proxy/addon dependency. Foundation for the
  realtime budget (task) and manual quality.
