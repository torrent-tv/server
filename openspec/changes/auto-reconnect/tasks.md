# Tasks: Automatic reconnect

Execute in order. design.md is normative — constants, member names, message
strings and the do-NOT list are decisions, not suggestions. Before task 1,
read the code regions listed at the top of design.md.

## 1. Transport plumbing

- [ ] 1.1 `public/domain/webrtc-proxy.js`: add read-only getters `proxyId`,
      `proxyLocalPort`, `allowsPrivateCandidates` (return the existing
      private fields; no other change). Verify: `node --check`.
- [ ] 1.2 `public/components/proxy-selector/proxy-selector.js`: add
      `reconnectTo(descriptor, { connectTimeoutMs })` per design.md —
      construct `WebRtcProxy`, `connect(connectTimeoutMs)`, return it; on
      error `close()` + rethrow. No health call, no scoring, no permission
      flow. Verify: `node --check`.

## 2. Loading: adoption and factored resume

- [ ] 2.1 `loading.js`: add `#lastProxyDescriptor = null` field and the
      `#adoptProxy(proxy)` helper (design.md); rewrite the success path of
      `#acquireTransport` to use it (behaviour identical, descriptor now
      captured). Verify in preview: normal playback still works end-to-end
      against the dev HA proxy.
- [ ] 2.2 `loading.js`: factor the resume body of `#onRetryPlayback` into
      `#resumePlayback(resume)` (restore session, epoch, switch file, seek)
      and make `#onRetryPlayback` call it. Behaviour of manual Retry must
      be byte-for-byte equivalent. Verify: simulate a loss (console:
      temporarily call the transport-lost path or stop the HA addon during
      playback), click Retry on the error screen, playback resumes.

## 3. Loading: the auto-reconnect loop

- [ ] 3.1 Add the constants and the two new `Loading.MESSAGES` strings
      (exact values in design.md).
- [ ] 3.2 Implement `#autoReconnect(resume)` exactly per the design.md
      pseudocode: cycle guard, dead-ref cleanup (`#proxy.close()`, null
      `#proxy`/`#transport`), LOADING SHOW, per-attempt cancel check,
      backoff before attempt 2, offline wait, same-proxy attempts via
      `reconnectTo` + `#adoptProxy`, final attempt via `#acquireTransport`,
      resume via `#resumePlayback`, `[torrent-tv]` debug line per attempt,
      final PLAYBACK_FAILED dispatch identical to today's.
- [ ] 3.3 Rewire `#onTransportLost`: keep the existing early returns and
      snapshot code, clear the pending stability timer, then
      `void this.#autoReconnect(resume)` instead of dispatching
      PLAYBACK_FAILED. Add the stability timer on successful resume
      (RECONNECT_STABLE_RESET_MS → `#reconnectCycles = 0`).

## 4. Verification (preview + dev HA proxy)

- [ ] 4.1 Happy path: start playback from the dev proxy, kill the
      connection (restart the addon container, or toggle the machine's
      Wi-Fi off and on — the Wi-Fi toggle also exercises the offline wait).
      Expect: loading view "reconnecting (attempt N of 3)", automatic
      resume near the previous position, NO error screen, no user click.
- [ ] 4.2 Total failure: stop the addon and keep it stopped. Expect: 3
      attempts (2 fast same-proxy failures, then the re-selection attempt),
      then the error screen with Retry — and Retry still works once the
      addon is back.
- [ ] 4.3 Cancel: during the loop press Cancel. Expect: silent stop,
      standard cancel navigation, no error screen afterwards.
- [ ] 4.4 Console/log check: the attempt lines appear with the
      `[torrent-tv]` prefix locally, and (after release) in the droplet
      server log via the client-log pipeline with `sig=<session>` prefixes.
- [ ] 4.5 Regression: normal cold start, episode switch in a season pack,
      manual quality switch, and the local-network walkthrough (attempt-3
      path) all behave as before.

## 5. Release

- [ ] 5.1 CHANGELOG entry at current version + 1 patch (expected 0.8.56),
      matching the existing format; do NOT edit package.json.
- [ ] 5.2 Commit; `npm run patch` in `server/`; verify live via
      `window.env.version` and a real mid-playback loss on the deployed
      site. Server-only — no proxy/addon release.
