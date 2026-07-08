# Proxy-side lifecycle verification (task 1.4)

Verified in the `proxy/` repo, 2026-07-08. Conclusion: **the warm-resume
window holds — no proxy change is required for Level 1.**

## Does a dead WebRTC channel tear down the warm sessions? NO.

- `services/webrtc-manager.js` `closeSession()` (and the `state → failed/
  closed` handler) close ONLY the `RTCPeerConnection`. Nothing else.
- `services/data-channel-handler.js` `channel.onClosed(...)` **only logs**
  (`[dc] Session …: channel closed`). It holds no per-connection session
  state and disposes nothing. Requests are stateless forwards to the
  loopback HTTP server.
- So on channel death, neither the HLS transcode session nor the torrent is
  disposed. They persist on their own idle timers.

## Transcode session lifetime (`services/hls-session-manager.js`)

- Keyed by (source, file, settings); tracked by a `consumers` Set +
  `lastAccessedAt`. `DEFAULT_SESSION_TTL_MS = 120_000`.
- Disposed only when: (a) the last consumer calls
  `releaseSessionConsumer` (triggered by the client's explicit
  `POST /api/transcode-sessions/:id/release`), or (b) idle > 120 s since
  `lastAccessedAt`, swept by the periodic cleanup.
- A channel death sends NO release, so the session idles out after ~120 s.
  Segment/playlist fetches refresh `lastAccessedAt`, so a reconnect that
  resumes fetching within the window keeps it alive.

## Torrent lifetime (`services/torrent-pool.js`)

- Refcount + idle TTL (~300 s), shutdown teardown. Not tied to the WebRTC
  connection either. Comfortably outlives the transcode-session window.

## Correction to a stale client comment

`server/public/domain/torrent-session.js` (~line 73) says "the proxy
session expires when the data channel closes anyway". That is INACCURATE:
it expires by the 120 s idle TTL, not on channel close. Harmless today
(release is best-effort on unload), but do not rely on it for reconnect —
the 120 s window is what makes seamless resume work. (Left as-is; not in
this change's scope to reword.)

## Seamless success signal (design refinement)

The design's "re-affirm the source registration" step does NOT work as a
liveness probe: `registerSourceOnProxy` is cached per `transport.baseUrl`
(a constant fake host for WebRTC), so a second call returns the cached key
with no round-trip. And `videoElement.currentTime` cannot signal success —
the video keeps advancing from its buffer regardless of whether the new
channel serves anything, and `FRAG_LOADED` timing is unreliable while the
buffer is full.

Chosen signal: after the swap, `await session.fetchActiveTranscodeProgress()`
— it routes through the SAME transport object (its `fetchFn` closes over
`transport`, which we mutate in place via `replaceWebRtcProxy`), hits
`GET /api/transcode-sessions/:id/progress`, and returns the progress object
iff the session is still alive. Non-null → seamless confirmed, call
`startLoad()`. Null/throw → the session is gone (reconnect took too long);
skip the remaining same-proxy attempts and fall to the Level 2 rebuild
(which recreates the session and seeks). For direct-play or any path with
no active progress poll, the probe is null → Level 2, the correct
degradation.
