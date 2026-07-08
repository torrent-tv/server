# Design: Automatic reconnect (make-before-break)

Written to be executed as specified — file names, member names, constants
and edge cases are normative. Read these code regions before writing any
code:

- `public/components/loading/loading.js`: `#onTransportLost`,
  `#onRetryPlayback`, `#acquireTransport` (line ~1200),
  `#playWithProxyTranscode`, the `createWebRtcHlsLoader(this.#proxy)` call
  (line ~1926), `Loading.MESSAGES`, `#cancelRequested` /
  `#throwIfCancelled`, `#beginPlaybackAttempt` / `#failPlayback`,
  `#resumeState`.
- `public/domain/webrtc-proxy.js`: constructor, `connect(timeoutMs)`,
  `onConnectionLost` + `#fireConnectionLost`, `close()`.
- `public/domain/proxy-transport.js`: `fromWebRtc` (line ~146), `#fetchFn`.
- `public/domain/webrtc-hls-loader.js`: `createWebRtcHlsLoader(proxy)` —
  note it only ever calls `proxy.fetch(...)`.
- `public/domain/hls-player.js`: what `play()` returns and where the `Hls`
  instance lives.
- `public/components/proxy-selector/proxy-selector.js`: `chooseBestProxy`
  (how it constructs `WebRtcProxy` and derives `proxyLocalPort`).
- Proxy-side lifecycle (READ ONLY, to verify assumptions — in the `proxy/`
  repo): `services/webrtc-manager.js` (what happens on channel death),
  `services/torrent-pool.js` (refcount release),
  `services/hls-session-manager.js` (idle TTL ~120 s keeps ffmpeg sessions
  alive after a viewer vanishes).

## Decision 1: WebRTC ICE restart is NOT available — verified upstream

`RTCPeerConnection.restartIce()` would be the textbook fix (keep DTLS/SCTP,
renegotiate only the network path). It is impossible with the proxy's
stack, for a reason verified at the source (2026-07-08), not assumed:

- libjuice — the ICE layer under libdatachannel — cannot change ICE
  attributes once candidate gathering has started
  (`agent_set_local_ice_attributes` returns `JUICE_ERR_FAILED`); ICE
  restart support is the long-open upstream issue
  paullouisageneau/libdatachannel#545.
- PR #1568 ("Expose ICE restart through the C API") was closed unmerged:
  the C-API exposure is useless while libjuice lacks the mechanism, and
  the maintainer's preferred fix is implementing restart inside libjuice —
  which nobody has done.
- node-datachannel (0.32.3, bundles libdatachannel v0.24.2) accordingly has
  `restartIce() { throw new DOMException("Not implemented"); }` in its
  polyfill; the raw API the proxy uses has nothing at all.

Achieving true ICE restart would mean implementing it in an upstream C
library (libjuice) and shipping a patched build chain — out of proportion
for this product stage. Revisit if upstream lands #545 (then: browser
`restartIce()` + proxy re-offer handling + a session-grace period in
webrtc-manager become the follow-up change).

Note: changing the proxy and ha-addon is NOT a constraint — releases of all
three repos are routine. If verification (task 1.4) shows the proxy needs a
lifecycle adjustment, make it and bump proxy + addon per the release rules.

## Decision 2: make-before-break with a transport swap — the player is
## never torn down while there is hope

On loss, the player keeps playing from its buffer while a new connection is
built in the background; when it is ready, the transport is swapped UNDER
the live player and loading resumes. The viewer sees nothing unless the
buffer runs dry before the swap completes (then the native stall spinner,
which recovers by itself). A rebuild of the player is the FALLBACK, not the
plan; the error screen is the fallback's fallback:

    Level 1 (seamless): hls.stopLoad() → reconnect → swap transport →
      re-affirm source registration → hls.startLoad() — no visible break
    Level 2 (rebuild):  the existing manual-Retry flow, automated
      (#resumePlayback: switch file + server-side seek to position)
    Level 3 (manual):   today's error screen with Retry — unchanged

Level 1 works because nothing the player consumes is bound to the dead
WebRTC session: HLS URLs are stable paths on the proxy, the ffmpeg session
survives viewer loss for ~120 s (hls-session-manager idle TTL), torrent
data survives for ~300 s (torrent-pool idle TTL) — the same proxy resumes
serving the same playlist positions over a fresh data channel.

Level 1 applies to the HLS path. If the direct-play path turns out to fetch
media through the data channel by another route (verify in task 1.4), it
uses Level 2 — correctness over elegance there.

## The single swap point

Today two things hold the raw proxy: the transport closure
(`ProxyTransport.fromWebRtc(proxy)` captures it in `#fetchFn`) and the HLS
loader (`createWebRtcHlsLoader(this.#proxy)`). Both must route through ONE
replaceable reference:

1. `proxy-transport.js`: `fromWebRtc(proxy)` stores the proxy in a private
   field (`#webRtcProxy`); its fetchFn delegates to
   `this.#webRtcProxy.fetch(...)`. Add:

       replaceWebRtcProxy(newProxy)  // throws for HTTP transports

2. `webrtc-hls-loader.js`: change `createWebRtcHlsLoader(proxy)` →
   `createWebRtcHlsLoader(transport)` — it only needs `.fetch`. Update the
   call site (`loading.js` ~1926) to pass `this.#transport`, and the JSDoc
   examples in hls-player.js/webrtc-hls-loader.js.

After that, `transport.replaceWebRtcProxy(next)` atomically redirects both
API calls and all subsequent HLS manifest/segment fetches. In-flight
requests on the dead channel reject (hls.js sees a load error at worst
once — stopLoad prevents even that, see below).

## hls-player: expose load control

`createHlsPlayer(...)` returns `{ clear, play }`. Add two pass-throughs to
the current `Hls` instance (no-ops when using native HLS or when no
instance exists):

    stopLoad()   // hls.stopLoad() — freeze fetching, keep buffer + playback
    startLoad()  // hls.startLoad(-1) — resume from current position

Native-HLS (iOS Safari) has no such control: on that path Level 1 degrades
to "do nothing during reconnect, swap, and let the <video> element retry" —
if it does not recover within the attempt, Level 2 handles it.

## Constants (add near the other constants in loading.js)

    RECONNECT_SAME_PROXY_ATTEMPTS = 2   // attempts 1..2: same proxy
    RECONNECT_TOTAL_ATTEMPTS = 3        // attempt 3: full re-selection
    RECONNECT_CONNECT_TIMEOUT_MS = 10_000
    RECONNECT_BACKOFF_MS = 2_000        // pause before attempt 2
    RECONNECT_ONLINE_WAIT_MS = 15_000   // max wait for `online` per attempt
    RECONNECT_STABLE_RESET_MS = 30_000  // healthy playback resets cycle count
    RECONNECT_MAX_CYCLES = 3            // consecutive loss→recover cycles

## New members

### webrtc-proxy.js — read-only getters

    get proxyId()                 // returns #proxyId
    get proxyLocalPort()          // returns #proxyLocalPort
    get allowsPrivateCandidates() // returns #allowPrivateCandidates

### proxy-selector.js — reconnectTo

    async reconnectTo({ proxyId, proxyLocalPort, allowPrivateCandidates },
                      { connectTimeoutMs })

Constructs `new WebRtcProxy(proxyId, proxyLocalPort,
allowPrivateCandidates)`, calls `connect(connectTimeoutMs)`, returns the
proxy. On error: `proxy.close()` + rethrow. No health-API call, no scoring,
no permission flow — this is "dial the number that just worked".

### loading.js — descriptor capture and adoption

    #lastProxyDescriptor = null;

    #adoptProxy(proxy) {
      proxy.onConnectionLost = () => this.#onTransportLost();
      this.#proxy = proxy;
      if (this.#transport) {
        this.#transport.replaceWebRtcProxy(proxy);   // seamless swap
      } else {
        this.#transport = ProxyTransport.fromWebRtc(proxy);
      }
      this.#lastProxyDescriptor = {
        proxyId: proxy.proxyId,
        proxyLocalPort: proxy.proxyLocalPort,
        allowPrivateCandidates: proxy.allowsPrivateCandidates
      };
      return this.#transport;
    }

`#acquireTransport` uses it on its success paths, so EVERY successful
connection refreshes the descriptor and reuses the transport object when
one exists (references held by torrent-session etc. stay valid).

## The loss handler

Keep the existing early returns exactly as today (`#isProcessing`, no
current session / no active file) and the snapshot code (position,
fileIndex, sessionCurrent → `#resumeState`). Then, instead of dispatching
`PLAYBACK_FAILED`, call `void this.#autoReconnect(resume)` (async; must
never throw — catches everything):

    cycle guard:
      clear the pending stability timer
      #reconnectCycles += 1
      if #reconnectCycles > RECONNECT_MAX_CYCLES → dispatch PLAYBACK_FAILED
        (exactly today's object) and return

    freeze, do NOT tear down:
      this.#hlsControl?.stopLoad()        // player keeps playing buffer
      try { this.#proxy?.close() } catch {}   // silence the dead instance
      this.#proxy = null                  // transport object KEPT (swap target)

    NO loading overlay yet — the video is still playing from buffer.

    for attempt = 1 .. RECONNECT_TOTAL_ATTEMPTS:
      if user cancelled → return silently
      if attempt === 2 → await sleep(RECONNECT_BACKOFF_MS)
      if navigator.onLine === false →
        await online event OR RECONNECT_ONLINE_WAIT_MS, whichever first
      console.debug(`[torrent-tv] reconnect attempt ${attempt}/3 ` +
        (attempt <= RECONNECT_SAME_PROXY_ATTEMPTS ? "(same proxy)" : "(reselect)"))
      try:
        if attempt <= RECONNECT_SAME_PROXY_ATTEMPTS and #lastProxyDescriptor:
          proxy = await #proxySelector.reconnectTo(#lastProxyDescriptor,
                    { connectTimeoutMs: RECONNECT_CONNECT_TIMEOUT_MS })
          this.#adoptProxy(proxy)         // swap under the live player
          re-affirm the source registration over the new channel (the same
            call the switch flow uses to register the source; it is served
            warm by the proxy — duplicate-infoHash handling exists) so
            proxy-side refcounts/TTLs are held again
          this.#hlsControl?.startLoad()
          → success: arm the stability timer, log
            `[torrent-tv] reconnect: seamless resume`, return
        else:
          // different proxy (or no descriptor): the warm sessions are
          // gone — seamless is impossible. Show the loading view now
          // (LOADING_EVENTS.SHOW, status MESSAGES.reconnecting), then the
          // standard flow:
          await this.#acquireTransport()  // two-stage; may walk the
                                          // permission flow — acceptable
          await this.#resumePlayback(resume)   // Level 2 rebuild
          → success: arm the stability timer, return
      catch (error):
        if #isAbortError(error) or user cancelled → return silently
        console.debug(`[torrent-tv] reconnect attempt ${attempt} failed: ${message}`)
        // If the seamless resume failed AFTER a successful swap (e.g.
        // startLoad errors, registration rejected), fall through — the
        // NEXT iteration may retry same-proxy or reselect; Level 2 inside
        // attempt 3 is the rebuild safety net.
        continue

    all attempts failed → dispatch PLAYBACK_FAILED exactly as today
      (description: MESSAGES.connectionLost, canRetry: true). #resumeState
      is still set → the manual Retry (Level 3) keeps working.

Stability timer: after any successful recovery, `setTimeout(() =>
{ #reconnectCycles = 0 }, RECONNECT_STABLE_RESET_MS)`; store the handle;
clear it at the top of the loss handler.

`#resumePlayback(resume)` is the resume body factored OUT of
`#onRetryPlayback` (restore `#session.current`, `#beginPlaybackAttempt`,
`#switchToVideoFile(resume.fileIndex)`, seek to `resume.positionSeconds`
when > 1); the manual handler calls the same method so the two paths cannot
drift.

`#hlsControl` is whatever handle loading.js keeps on the hls-player
instance — reuse the existing field if one exists (check how `clear()` is
reached today); do not invent a parallel one.

## Rules — do NOT

- Do NOT call `#ensureLocalNetworkPermission` (or any permission UI) on the
  same-proxy path; the saved `allowPrivateCandidates` already encodes the
  policy that worked. Only the attempt-3 `#acquireTransport` may walk the
  permission flow.
- Do NOT change `CONNECT_TIMEOUT_MS` or the two-stage initial-connect
  timeouts.
- Do NOT remove or bypass the manual Retry path — its event contract
  (`PLAYBACK_FAILED`, `canRetry: true`, `#resumeState`) is unchanged.
- Do NOT run the loop when the loss arrives while `#isProcessing` or with
  no active file — the existing early returns stay first.
- Do NOT tear down the hls player or clear the video element on the
  same-proxy path — that is the whole point of Level 1.
- All new user-facing strings live in `Loading.MESSAGES`, English, same
  tone. Seamless recovery has NO user-facing strings at all.

## Messages (exact strings; only the non-seamless paths speak)

    waitingForNetwork: "Waiting for the network to come back…"

`MESSAGES.reconnecting` and `MESSAGES.connectionLost` already exist — reuse
them; do not duplicate. (The per-attempt counter goes to console/client-log
only — the seamless path must stay silent, and the loading view during
attempt 3 shows the existing reconnecting message.)

## Failure containment

The auto loop never throws out of the event callback; unknown errors end it
via the PLAYBACK_FAILED dispatch; cancellation ends it silently. Every
attempt and outcome is logged with the `[torrent-tv]` prefix so the 0.8.55
client-log pipeline delivers reconnect cycles to the server log next to the
proxy's `[webrtc] Session <id>` lines.
