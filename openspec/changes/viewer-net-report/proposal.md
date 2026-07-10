# Proposal: Viewer net report (client side of adaptive bitrate)

## Why

Counterpart of `proxy/adaptive-bitrate` (see its proposal for the field
evidence: cellular viewer starved by an uncapped ~18 Mbit/s stream). The
proxy can only adapt to the viewer's link if the viewer tells it how the
link is doing — and the client already measures exactly that: every
data-channel fetch records bytes and duration (the `dc-load`
instrumentation), and the player exposes buffered seconds.

## What Changes

During proxy-transcode playback the client sends, every ~10 s over the data
channel, `POST /api/transcode-sessions/:id/net-report` with:

- `linkMbps` — rolling median of per-fetch transfer throughput over the last
  ~30 s of segment fetches (median, not mean — a single stalled fetch must
  not crater the estimate);
- `bufferedAheadSec` — from the video element's buffered ranges at send time.

Fire-and-forget: failures are ignored (best-effort telemetry), sending stops
when the transcode session is released or playback stops. Reports are sent
regardless of the quality-menu mode; the PROXY ignores them when a manual
quality is pinned (that contract lives in the proxy change).

No UI. One debug log line per send on the `[torrent-tv]` channel (delivered
by the client-log pipeline) so field sessions show what was reported.

## Capabilities

### Modified Capabilities

- `transcode-playback` (client): playback feeds the proxy's link-adaptation
  trigger with measured throughput + buffer state.

## Impact

- `public/components/loading/loading.js` (or the module owning the dc-load
  samples): rolling sample store + 10 s reporter tied to the transcode
  session lifecycle.
- Server-only release, AFTER proxy 2.9.38+/addon ship (the route must exist
  first; a 404 from an old proxy is harmless but pointless).
