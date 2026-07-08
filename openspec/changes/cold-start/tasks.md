# Tasks: Cold-start reduction (client side)

Execute in order; design.md is normative.

## 1. Phase marks + summary line

- [ ] 1.1 Capture t0..t4 in the proxy-served branch of `#switchToVideoFile`
      (exact points in design.md) and log the single `cold-start …` summary
      via `#logEvt` after prebuffer-done. Guard against absent marks (no
      NaN); success-only.
- [ ] 1.2 Verify in preview (dev HA proxy): one line per successful start,
      sane numbers (phases sum ≈ total); no line on cancel/failure; the
      line arrives in the server container log via the client-log pipeline.

## 2. Earlier prebuffer start

- [ ] 2.1 Add `PREBUFFER_HEALTHY_FILL_RATE` (1.35) and
      `PREBUFFER_HEALTHY_AHEAD_SECONDS` (10) with the design.md comment;
      extend the start condition with the dual clause (full-window
      requirement!); extend the "prebuffer ready" log line with
      `start=early|target`.
- [ ] 2.2 Verify both branches: a fast source (LAN dev proxy, light file)
      starts with `start=early` at ~10 s buffered; throttle the path (or a
      heavy transcode) so fill rate < 1.35 → behaviour identical to today
      (`start=target`, adaptive target unchanged). No start-stutter on the
      early path (video plays ≥ 30 s without a stall right after start).

## 3. Release

- [ ] 3.1 CHANGELOG entry at current version + 1 patch; `npm run patch`;
      verify live via `window.env.version` + one real cold start showing
      the summary line in the droplet log.
