# Tasks: Automatic reconnect (make-before-break)

Execute in order. design.md is normative — constants, member names, message
strings and the do-NOT list are decisions, not suggestions. Before task 1,
read the code regions listed at the top of design.md.

## 1. Transport plumbing (single swap point)

- [x] 1.1 `public/domain/webrtc-proxy.js`: getters `proxyId`,
      `proxyLocalPort`, `allowsPrivateCandidates`. `node --check` OK.
- [x] 1.2 `public/domain/proxy-transport.js`: `fromWebRtc` holds the proxy
      in `#webRtcProxy` and delegates through it; `replaceWebRtcProxy`
      (throws for HTTP). Node unit test: fetch routes to A then B after
      swap; HTTP transport throws. PASS.
- [x] 1.3 `webrtc-hls-loader.js` takes the transport (calls
      `transport.fetch`); call site passes `this.#transport`; JSDoc updated.
- [x] 1.4 Proxy-side lifecycle verified — channel death does NOT tear down
      the HLS session or torrent (both idle-TTL based, 120 s / 300 s);
      findings in `notes-proxy-lifecycle.md`. NO proxy change needed. Also
      refined the seamless success signal to
      `session.fetchActiveTranscodeProgress()` (the source re-affirm idea
      does not probe — it is cached; see the note).
- [x] 1.5 `hls-player.js`: `stopLoad()` / `startLoad()` + `isActive()`.
      Verified in preview: safe no-ops with no instance.

## 2. Loading: adoption and factored resume

- [x] 2.1 `loading.js`: `#lastProxyDescriptor` + `#adoptProxy(proxy)`
      (reuses the transport via `replaceWebRtcProxy` when present);
      `#acquireTransport` success path routes through it.
- [x] 2.2 `loading.js`: `#resumePlayback(resume)` factored out; manual
      `#onRetryPlayback` delegates to it (equivalent behaviour, plus it now
      drops the dead transport first so retry always reconnects fresh).

## 3. Loading: the auto-reconnect loop

- [x] 3.1 Constants + `MESSAGES.waitingForNetwork`.
- [x] 3.2 `#autoReconnect(resume)` implemented (cycle guard + stability
      timer, freeze via stopLoad + drop dead proxy while KEEPING the
      transport/player, seamless same-proxy attempts with a live-session
      probe, session-gone → rebuild on the same channel, reselect rebuild,
      offline wait, `[torrent-tv]` logging, final PLAYBACK_FAILED).
      Refinement vs the pseudocode: on a good swap but expired transcode
      session, rebuild on the already-connected proxy instead of wasting a
      re-selection (see notes-proxy-lifecycle.md).
- [x] 3.3 `#onTransportLost` rewired: early returns + snapshot kept, pending
      stability timer cleared, then `void this.#autoReconnect(resume)`.

## 4. Verification (preview + dev HA proxy)

> Automated so far: `node --check` all six files; node unit test of the
> transport hot-swap (PASS); preview boot with zero console errors and all
> new APIs present (isActive/stopLoad/startLoad safe no-ops, replace,
> reconnectTo, WebRtcProxy getters). The live-loss scenarios below need the
> dev HA proxy + a real stream and are the field-test step.

- [ ] 4.1 Seamless path: start HLS playback from the dev proxy, kill ONLY
      the WebRTC path (restart the addon container is too coarse — it kills
      the warm sessions; instead break the path: toggle the machine's
      Wi-Fi off briefly, or use a firewall rule to drop UDP 9090 for ~10 s).
      Expect: video keeps playing from buffer, console shows
      `reconnect attempt 1/3 (same proxy)` then `seamless resume`, NO
      overlay, NO player restart, position keeps advancing.
- [ ] 4.2 Rebuild path: stop the addon long enough that same-proxy attempts
      fail, keep a second proxy available (or restart the addon before
      attempt 3). Expect: loading view with the reconnecting message,
      automated resume near the captured position, no manual click.
- [ ] 4.3 Total failure: addon stopped, no other proxy. Expect: attempts
      1–2 fail fast (~10 s each), attempt 3 fails, error screen with Retry;
      Retry still works once the addon is back.
- [ ] 4.4 Wi-Fi toggle (offline branch): turn Wi-Fi off ≥5 s, back on.
      Expect: the loop waits (no burned attempts while offline), reconnects
      after `online`, seamless when the buffer survived.
- [ ] 4.5 Cancel during the loop → silent stop, standard cancel navigation,
      no error screen afterwards.
- [ ] 4.6 Relapse guard: kill the path 3× in rapid succession → error
      screen; after 30 s of healthy playback the counter resets (verify via
      a 4th kill going through the full cycle again).
- [ ] 4.7 Log check: attempt lines appear locally with the `[torrent-tv]`
      prefix and (after release) in the droplet server log via the
      client-log pipeline with `sig=<session>` prefixes.
- [ ] 4.8 Regression: cold start, episode switch in a season pack, manual
      quality switch, subtitles, the local-network walkthrough (attempt-3
      path), iOS-Safari native-HLS playback (Level 1 degrades gracefully,
      Level 2 covers it).

## 5. Release

- [ ] 5.1 CHANGELOG entry at current version + 1 patch (expected 0.8.56),
      matching the existing format; do NOT edit package.json.
- [ ] 5.2 Commit; `npm run patch` in `server/`; verify live via
      `window.env.version` and a real mid-playback loss on the deployed
      site. If task 1.4 required a proxy fix: release proxy FIRST
      (`npm run patch` there), then bump the addon, then the server —
      order per the root CLAUDE.md.
