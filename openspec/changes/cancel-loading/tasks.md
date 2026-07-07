# Tasks: Cancel button on the loading screen

## 1. Implementation

- [x] 1.1 index.html: cancel button as a direct child of `#loading` (no
      wrappers); loading.css styles (rem units, view tokens, color inherit)
- [x] 1.2 loading.js: `#cancelRequested` flag + `#throwIfCancelled()`
      checkpoints (post-transport, plan-poll loop, transcode start,
      prebuffer loop); flag reset at process/switch/retry start
- [x] 1.3 loading.js: cancel handler — partial teardown keeping
      `session.current` and the transport; BACK_TO_PLAYLIST (multi-file) /
      RESET_TO_PICKER (single-file)

## 2. Verification and release

- [x] 2.1 Preview: cancel visible on the loading screen; multi-file cancel
      opens a populated playlist; single-file cancel opens the picker; no
      PLAYBACK_READY after cancel
      (verified: button rendered with theme tokens; cancel with no session →
      picker opens, loading closes, no PLAYBACK_READY; multi-file branch is
      code-reviewed — session.current is only settable by a real torrent
      flow — field-check on the phone covers it)
- [x] 2.2 CHANGELOG.md entry at current package.json version + 1 patch
- [ ] 2.3 Deploy; field-check on the phone with a slow torrent
