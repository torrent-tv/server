# Proposal: Cold-start reduction (client side)

## Why

Field recordings (mobile tester, 2026-07-08) show ~90 seconds from picking
an episode to a picture: ~25 s metadata/plan, ~25 s transcode prepare +
first segment, ~40 s prebuffer. The client owns two problems in that:

1. **No phase timing reaches the field logs.** The phases are visible only
   as status-text changes on a screen recording; the client-log pipeline
   (0.8.55) delivers console lines to the server, but nothing summarises
   where a start spent its time.
2. **The prebuffer keeps waiting after the margin is proven.** The adaptive
   target (`PREBUFFER_BASE/margin`, capped 6..25 s) sizes the buffer for the
   measured fill rate — but in the 1.35–2 fill-rate band it caps out near
   25 s and the viewer stares at "Buffering…" for ~15–20 s of wall time even
   though delivery has sustained a healthy surplus for the whole
   measurement window.

The proxy-side half (killing a redundant ffmpeg probe, prefetching the file
body start, stage timings) is the proxy repo's `cold-start` change. The two
are independent — either releases alone. Honest expectation: the recorded
worst case (fill rate ≈ 1.2, margin 0.2) is NOT helped by the prebuffer
change here — its target stays maximal by design (safety); that band is
attacked by the proxy-side warm-up cuts and, fundamentally, by encoder
speed (transcode-quality tail work, out of scope).

## What Changes

- **Cold-start summary line.** The playback flow records phase marks
  (transport acquired, plan ready, prepare done, prebuffer done) and logs
  ONE summary on success:
  `[torrent-tv] cold-start total=…ms transport=…ms plan=…ms prepare=…ms prebuffer=…ms`
  — console-only, rides the client-log pipeline next to the proxy's
  per-stage lines. No user-facing output.
- **Earlier start on a sustained healthy margin.** Playback may begin before
  the adaptive target when BOTH hold over the FULL rate window (10 s — the
  same anti-burst protection that fixed the 0.8.45 start-stutter):
  buffered ≥ 10 s AND measured fill rate ≥ 1.35. Cuts up to ~10 s of wall
  time in the healthy band; low-margin behaviour is unchanged.

## Capabilities

### New Capabilities

- `cold-start`: client-side startup latency measurement and prebuffer start
  policy.

## Impact

- `public/components/loading/loading.js` — phase marks + summary line; the
  dual start condition and two constants in `#waitForPrebuffer`.
- No new user-facing strings; no proxy/server-API change; server-only
  release.
