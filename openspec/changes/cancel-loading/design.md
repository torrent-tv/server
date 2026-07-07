# Design: Cancel button on the loading screen

## Context

The loading flow (`#processPlayback` / `#switchToVideoFile` →
`#playVideoFile`) awaits transport acquisition, a plan-poll loop (up to
180 s), transcode warm-up and an adaptive prebuffer (up to 30 s). Abort
errors are already treated as silent by every caller (`#isAbortError`), and
`session.abortPendingRequests()` exists. There is no user-facing way to
trigger any of it.

## Goals / Non-Goals

**Goals:** one tap aborts the flow at any phase; multi-file torrents return
to the playlist with the file list intact; single-file returns to the
picker; a cancelled flow can never late-fire `PLAYBACK_READY`.

**Non-Goals:** cancelling during playback (that is the player's close
button); killing the WebRTC transport (kept for the next selection).

## Decisions

1. **No new wrappers**: the button is a direct child of the `#loading`
   dialog (markup rule).
2. **Cooperative cancellation flag** (`#cancelRequested`) + a
   `#throwIfCancelled()` checkpoint that throws an `AbortError`-named error,
   inserted at the await boundaries: after transport acquisition, each
   plan-poll iteration, transcode start, and the prebuffer loop. Reusing the
   existing abort-error convention means every caller already handles it
   silently, and a throw guarantees the flow cannot reach its
   `PLAYBACK_READY` dispatch. The flag resets at the start of every new
   flow (process/switch/retry).
3. **Teardown on cancel**: abort pending requests, release transcode
   sessions (`reason: "cancel"`), clear hls.js and subtitle tracks, reset
   the video element — but KEEP `session.current` and the transport.
   Multi-file cancel must leave the playlist usable
   (`#onSelectMediaFile` guards on `session.current`), and the open data
   channel is reusable for the next file.
4. **Destination by video count**: `media.video.length > 1` →
   `APP:BACK_TO_PLAYLIST` (existing event: player becomes visible with the
   drawer open; torrent-tv transitions PROCESSING→PLAYING); otherwise
   `APP:RESET_TO_PICKER` (full reset path clears everything).

## Risks / Trade-offs

- [Bounded waits (prebuffer 30 s) may run to their own timeout if a
  checkpoint is missed] → checkpoints placed inside those loops, not only
  between them.
- [Cancel keeps the transport; if the user cancelled because the proxy is
  stuck, the next attempt reuses the stuck proxy] → acceptable v1; a failed
  next attempt surfaces the normal error path (and Retry re-selects).
