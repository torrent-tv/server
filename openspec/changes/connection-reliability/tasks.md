# Tasks: Connection reliability

## 1. Reachable-first selection

- [x] 1.1 health route: requester public IP (CF-Connecting-IP → XFF[0] →
      socket), `reachable` + `sameNetwork` per client
- [x] 1.2 proxy-selector: prefer `reachable || sameNetwork` group, fall back
      to all; expose the flags in debug state

## 2. Connection-loss retry

- [x] 2.1 webrtc-proxy: `onConnectionLost` callback (post-connect, once,
      suppressed by own close())
- [x] 2.2 events: `APP:RETRY_PLAYBACK`
- [x] 2.3 loading: active-file tracking, loss handler with session/position
      snapshot, `PLAYBACK_FAILED {canRetry}` dispatch, retry handler
      (restore snapshot → #switchToVideoFile → seek to position)
- [x] 2.4 error view: Retry button (shown for canRetry), dispatches
      APP:RETRY_PLAYBACK
- [x] 2.5 torrent-tv: canRetry passthrough to ERROR:SHOW; RETRY_PLAYBACK →
      PROCESSING transition + busy flag

## 3. Verification and release

- [x] 3.1 Preview: health API fields present; selector prefers reachable
      (mock payloads); retry flow drives events end-to-end with a stub
      transport loss
      (verified: reachable-weak (score 0.03) picked over unreachable-strong
      (0.72); fallback to all when none reachable; Retry button
      shown/fires/hides correctly; health route smoke-tested)
- [x] 3.2 CHANGELOG.md entry at current package.json version + 1 patch
- [ ] 3.3 Deploy; field-verify retry by restarting the addon mid-playback
