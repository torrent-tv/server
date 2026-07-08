# Tasks: Automatic reconnect (make-before-break)

Execute in order. design.md is normative — constants, member names, message
strings and the do-NOT list are decisions, not suggestions. Before task 1,
read the code regions listed at the top of design.md.

## 1. Transport plumbing (single swap point)

- [ ] 1.1 `public/domain/webrtc-proxy.js`: add read-only getters `proxyId`,
      `proxyLocalPort`, `allowsPrivateCandidates` (return the existing
      private fields; no other change). Verify: `node --check`.
- [ ] 1.2 `public/domain/proxy-transport.js`: `fromWebRtc` stores the proxy
      in a private field and delegates fetch to it; add
      `replaceWebRtcProxy(newProxy)` (throws for HTTP transports).
      Verify: `node --check`; normal playback unchanged in preview.
- [ ] 1.3 `public/domain/webrtc-hls-loader.js`:
      `createWebRtcHlsLoader(transport)` instead of `(proxy)` — it only
      calls `.fetch`. Update the call site in loading.js (~1926) to pass
      `this.#transport`, and the JSDoc examples here and in hls-player.js.
      Verify: HLS playback works in preview against the dev HA proxy.
- [ ] 1.4 Verify proxy-side lifecycle assumptions (READ ONLY, `proxy/`
      repo): (a) what `webrtc-manager.js` tears down when a channel dies —
      confirm HLS sessions and torrent registrations are NOT killed with
      it; (b) `hls-session-manager.js` idle TTL (~120 s) and
      `torrent-pool.js` idle TTL (~300 s) — confirm the warm-resume window;
      (c) which client API call re-affirms a source registration and that a
      duplicate registration of a live source is safe (duplicate-infoHash
      handling, proxy 2.9.27). Record findings in a short note inside this
      change folder (`notes-proxy-lifecycle.md`). IF a teardown kills the
      warm sessions on channel death, STOP and fix that in the proxy first
      (own commit, proxy + addon release per the standard rules) — Level 1
      depends on it.
- [ ] 1.5 `public/domain/hls-player.js`: expose `stopLoad()` /
      `startLoad()` pass-throughs to the live `Hls` instance (no-ops for
      native HLS / no instance). Verify: calling them from the console
      mid-playback freezes and resumes segment fetching.

## 2. Loading: adoption and factored resume

- [ ] 2.1 `loading.js`: add `#lastProxyDescriptor` and `#adoptProxy(proxy)`
      per design.md (reuses the existing transport object via
      `replaceWebRtcProxy` when present); rewire the success paths of
      `#acquireTransport` through it. Verify in preview: normal playback
      end-to-end.
- [ ] 2.2 `loading.js`: factor the resume body of `#onRetryPlayback` into
      `#resumePlayback(resume)`; the manual handler calls it. Manual Retry
      behaviour must be byte-for-byte equivalent. Verify: stop the HA addon
      mid-playback, click Retry on the error screen after it is back —
      playback resumes.

## 3. Loading: the auto-reconnect loop

- [ ] 3.1 Add the constants and `MESSAGES.waitingForNetwork` (exact values
      in design.md).
- [ ] 3.2 Implement `#autoReconnect(resume)` exactly per the design.md
      pseudocode: cycle guard + stability timer, freeze (stopLoad, close
      dead proxy, KEEP the transport object and the player), no overlay on
      the same-proxy path, per-attempt cancel check, backoff before
      attempt 2, offline wait, same-proxy attempts via `reconnectTo` +
      `#adoptProxy` + source re-affirmation + `startLoad()`, attempt-3
      loading view + `#acquireTransport` + `#resumePlayback`, `[torrent-tv]`
      debug line per attempt and outcome, final PLAYBACK_FAILED dispatch
      identical to today's.
- [ ] 3.3 Rewire `#onTransportLost`: keep the existing early returns and
      snapshot code, clear the pending stability timer, then
      `void this.#autoReconnect(resume)`.

## 4. Verification (preview + dev HA proxy)

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
