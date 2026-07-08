# Design: Cold-start reduction (client side)

Written to be executed as specified. Read before coding, all in
`public/components/loading/loading.js`:

- the proxy-transcode flow inside `#switchToVideoFile` (~line 964:
  `#acquireTransport` → `registerSourceOnProxy` → the plan poll loop →
  decision → `#playWithProxyTranscode`),
- `#waitForPrebuffer` (~line 2246) and the PREBUFFER_* constants
  (~line 3059),
- `#logEvt` (existing `[torrent-tv]`-prefixed logging helper).

## 1. Phase marks + summary line

Marks are `performance.now()` values captured in local variables /
one private field — NOT new class state machinery:

- `t0` — entry of the proxy-served branch of `#switchToVideoFile` (right
  before `#acquireTransport`),
- `t1` — transport acquired,
- `t2` — plan poll loop exited with a real plan,
- `t3` — `#playWithProxyTranscode` resolved (manifest parsed, player set
  up; for the direct-play branch, the equivalent resolve point),
- `t4` — `#waitForPrebuffer` returned.

After t4 (the same place that dispatches playback readiness), log ONCE:

    this.#logEvt(
      `cold-start total=${Math.round(t4 - t0)}ms ` +
      `transport=${Math.round(t1 - t0)}ms plan=${Math.round(t2 - t1)}ms ` +
      `prepare=${Math.round(t3 - t2)}ms prebuffer=${Math.round(t4 - t3)}ms`
    );

Rules:
- Console-only (`#logEvt` already is). NO status-text changes.
- Log only on SUCCESS reaching prebuffer-done; a failed/cancelled flow logs
  nothing (its failure paths already log).
- Threading the marks through `#playWithProxyTranscode` is not needed —
  take t3 around the call at the call sites in `#switchToVideoFile`.
- The webseed/direct branch may skip the summary (rare, not the case we
  measure); guard so absent marks never produce NaN in the line.

## 2. Earlier prebuffer start (dual condition)

Constants, next to the other PREBUFFER_* constants, with this comment
rationale:

    // Start early when the fill rate has SUSTAINED a healthy surplus over
    // the FULL rate window. The full-window requirement is the same
    // anti-burst protection that fixed the start-stutter (0.8.45): a burst
    // must not masquerade as a sustained rate. Low margins keep the
    // adaptive target unchanged.
    const PREBUFFER_HEALTHY_FILL_RATE = 1.35;
    const PREBUFFER_HEALTHY_AHEAD_SECONDS = 10;

In `#waitForPrebuffer`, the start check today is `ahead >= target` (with
`target` adaptive). It becomes: start when

    ahead >= target
    || (
      ahead >= PREBUFFER_HEALTHY_AHEAD_SECONDS &&
      Number.isFinite(fillRate) &&
      fillRate >= PREBUFFER_HEALTHY_FILL_RATE &&
      wallSpan >= PREBUFFER_RATE_WINDOW_MS / 1000
    )

`wallSpan` is the existing sample-window span variable — the shortcut
REQUIRES the full 10 s window (the adaptive target only needs
PREBUFFER_RATE_MIN_SPAN_MS = 5 s). When the shortcut triggers, the existing
"prebuffer ready" log line must say so — extend it with a
`start=early|target` field.

Effect envelope (state this in the verification): fill rate ≥ ~2.1 — the
adaptive target (≤ 11 s) already beats the shortcut, nothing changes;
1.35–2.1 — the shortcut saves up to ~10 s of wall time; < 1.35 — unchanged
(deliberately: small margins need the deep buffer).

## Rules — do NOT

- Do NOT change PREBUFFER_TARGET/MIN/MAX/BASE or the window constants.
- Do NOT lower the full-window requirement of the shortcut — that is the
  anti-stutter guarantee.
- Do NOT add user-facing strings or status changes; this change is
  invisible except for starting sooner.
- Do NOT touch the seek/stall machinery or hls.js buffer config.
