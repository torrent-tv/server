# Design: Automatic reconnect

Written to be executed as specified — file names, member names, constants
and edge cases are normative. Read these code regions before writing any
code:

- `public/components/loading/loading.js`: `#onTransportLost`,
  `#onRetryPlayback`, `#acquireTransport`, `#playWithProxyTranscode`,
  `Loading.MESSAGES`, `#cancelRequested` / `#throwIfCancelled`,
  `#beginPlaybackAttempt` / `#failPlayback`, `#resumeState`.
- `public/domain/webrtc-proxy.js`: constructor, `connect(timeoutMs)`,
  `onConnectionLost` + `#fireConnectionLost`, `close()`.
- `public/components/proxy-selector/proxy-selector.js`: `chooseBestProxy`
  (how it constructs `WebRtcProxy` and derives `proxyLocalPort`).

## Decision: app-layer reconnect, NOT WebRTC ICE restart

`RTCPeerConnection.restartIce()` would be the textbook fix (keep DTLS/SCTP,
renegotiate only the network path), but it requires the proxy to accept a
re-offer on an existing session. The proxy's WebRTC stack (libdatachannel
via node-datachannel) has incomplete renegotiation support, and both the
server signal hub and the proxy's webrtc-manager assume one offer per
session — supporting in-session re-offers means proxy + server + addon
releases and cannot be verified without a mobile field environment.

Chosen instead: rebuild the connection at the app layer, reusing the
battle-tested connect path end-to-end. Costs one extra DTLS + SCTP
handshake per reconnect (~1–3 s on a working path) — negligible against
today's manual-click + full-restart reality. Server-repo-only, field-ready
immediately. Revisit ICE restart only if reconnect latency measured via the
client-log pipeline proves too slow.

Also out of scope, deliberately:

- **Seamless swap under a live player** (keep hls.js alive, replace the
  transport beneath it, no visible interruption): requires ProxyTransport
  to delegate to a replaceable inner proxy — a separate refactor. This
  change replays the existing file-switch flow (player rebuild + server-side
  seek), same as manual Retry today.
- **Initial connect-timeout tuning** (first-ever connection): unchanged.
  Only reconnect attempts get the short timeout.

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

No behaviour change. They exist so the app can save a descriptor of the
connection that worked and rebuild it.

### proxy-selector.js — reconnectTo

    async reconnectTo({ proxyId, proxyLocalPort, allowPrivateCandidates },
                      { connectTimeoutMs })

Constructs `new WebRtcProxy(proxyId, proxyLocalPort,
allowPrivateCandidates)`, calls `connect(connectTimeoutMs)`, returns the
proxy. On error: `proxy.close()` and rethrow. No health-API call, no
scoring, no permission flow — this is "dial the number that just worked".

### loading.js — descriptor capture and adoption

Factor a private helper out of the tail of `#acquireTransport`:

    #adoptProxy(proxy) {
      proxy.onConnectionLost = () => this.#onTransportLost();
      this.#proxy = proxy;
      this.#transport = ProxyTransport.fromWebRtc(proxy);
      this.#lastProxyDescriptor = {
        proxyId: proxy.proxyId,
        proxyLocalPort: proxy.proxyLocalPort,
        allowPrivateCandidates: proxy.allowsPrivateCandidates
      };
      return this.#transport;
    }

`#acquireTransport` calls it for its success path (both attempt branches),
so EVERY successful connection — initial, reconnect-by-reselection —
refreshes the descriptor. Same-proxy reconnect calls it with the
`reconnectTo` result.

## The loss handler (replaces the body of `#onTransportLost`)

Keep the existing early returns exactly as they are today (`#isProcessing`,
no current session / no active file). Keep the existing snapshot code
(position, fileIndex, sessionCurrent → `#resumeState`). Then, instead of
dispatching `PLAYBACK_FAILED`, start the auto loop (a private async method,
e.g. `#autoReconnect(resume)`; `#onTransportLost` stays sync and calls
`void this.#autoReconnect(resume)`):

    cycle guard:
      #reconnectCycles += 1
      if #reconnectCycles > RECONNECT_MAX_CYCLES → dispatch PLAYBACK_FAILED
        (exactly the object dispatched today) and return

    cleanup of dead refs (IMPORTANT — #playWithProxyTranscode falls back to
    this.#transport, which now points at a dead channel):
      try { this.#proxy?.close() } catch {}
      this.#proxy = null
      this.#transport = null

    show the loading view: dispatch LOADING_EVENTS.SHOW with
      { status: MESSAGES.reconnecting, progress: 0 }  // same as manual Retry
    reset #cancelRequested = false (mirrors #onRetryPlayback)

    for attempt = 1 .. RECONNECT_TOTAL_ATTEMPTS:
      if user cancelled → stop silently (return; the cancel flow already
        navigates away)
      if attempt === 2 → await sleep(RECONNECT_BACKOFF_MS)
      if navigator.onLine === false →
        setStatus("Waiting for the network to come back…")
        await online event OR RECONNECT_ONLINE_WAIT_MS, whichever first
      setStatus(`Connection lost — reconnecting (attempt ${attempt} of 3)…`)
      console.debug(`[torrent-tv] reconnect attempt ${attempt}/3 ` +
        (attempt <= RECONNECT_SAME_PROXY_ATTEMPTS ? "(same proxy)" : "(reselect)"))
      try:
        if attempt <= RECONNECT_SAME_PROXY_ATTEMPTS and #lastProxyDescriptor:
          proxy = await #proxySelector.reconnectTo(#lastProxyDescriptor,
                    { connectTimeoutMs: RECONNECT_CONNECT_TIMEOUT_MS })
          this.#adoptProxy(proxy)
        else:
          await this.#acquireTransport()   // standard two-stage flow;
            // it may show the local-network walkthrough — acceptable, the
            // loading view is already on screen and Cancel works
        → connected: replay playback (below) and return on success
      catch (error):
        if #isAbortError(error) or user cancelled → return silently
        console.debug(`[torrent-tv] reconnect attempt ${attempt} failed: ` +
          message)
        continue

    all attempts failed → dispatch PLAYBACK_FAILED exactly as today
      (description: MESSAGES.connectionLost, canRetry: true). #resumeState
      is still set, so the manual Retry keeps working as the last resort.

Replaying playback: factor the resume body out of `#onRetryPlayback`
(restore `#session.current`, `#beginPlaybackAttempt`, `#switchToVideoFile
(resume.fileIndex)`, seek to `resume.positionSeconds` when > 1) into a
shared private method (e.g. `#resumePlayback(resume)`) used by BOTH the
manual handler and the auto loop, so the two paths cannot drift. In the
auto loop, a `#resumePlayback` failure counts as that attempt's failure
(catch → continue), EXCEPT abort/cancel which returns silently.

Cycle-counter reset: after a successful resume, start (and store) a
`setTimeout(() => { #reconnectCycles = 0 }, RECONNECT_STABLE_RESET_MS)`;
clear the pending timer at the top of `#onTransportLost` so a quick relapse
does not get reset underneath.

## Rules — do NOT

- Do NOT touch the proxy repo, the server routes, or signalling — this
  change is entirely in `public/`.
- Do NOT call `#ensureLocalNetworkPermission` (or any permission UI) on the
  same-proxy path; the saved `allowPrivateCandidates` already encodes the
  policy that worked. Only the attempt-3 `#acquireTransport` may walk the
  permission flow, since it is the standard acquire.
- Do NOT change `CONNECT_TIMEOUT_MS` or the two-stage initial-connect
  timeouts.
- Do NOT remove or bypass the manual Retry path — it remains the final
  fallback and its event contract (`PLAYBACK_FAILED`, `canRetry: true`,
  `#resumeState`) is unchanged.
- Do NOT let the loop run when the loss arrives while `#isProcessing` or
  with no active file — the existing early returns stay first.
- All new user-facing strings live in `Loading.MESSAGES` next to the
  existing ones, English, same tone.

## Messages (exact strings)

    reconnectingAttempt: (used with attempt interpolation at the call site)
      "Connection lost — reconnecting (attempt N of 3)…"
    waitingForNetwork: "Waiting for the network to come back…"

`MESSAGES.reconnecting` and `MESSAGES.connectionLost` already exist — reuse
them; do not duplicate.

## Failure containment

The auto loop must never throw out of `#onTransportLost` (it is called from
an event callback): the async method catches everything; unknown errors end
the loop via the PLAYBACK_FAILED dispatch. Cancellation ends it silently.
