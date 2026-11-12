# Tasks: append-execute-span (torrent-tv/meta#260, parent #185)

Branch `claude/project-thread-9f2a6v`. Pass/fail command: `npm test` in the
server (lint plus `node --test`).

## Acceptance criteria

| id | criterion | check |
|---|---|---|
| S-AC-1 | `observeHlsAppendService` records `executeMs = executeEnd - executeStart` from `data.chunkMeta.buffering[data.type]` at the appended event (105 → 125 gives 20) and `snapshot` returns it on the sample; `elapsedMs` unchanged. | unit, `test/append-service.test.js` |
| S-AC-2 | Missing `chunkMeta`, missing type entry, `executeStart` 0, non-finite marks, or `executeEnd < executeStart` → `executeMs: null`; the sample is still recorded. `record` with a negative or non-finite `executeMs` stores `null`. | unit, same file |
| S-AC-3 | Existing tests that deep-equal samples are updated with `executeMs`; changeset present; `npm test` exits 0. | CI, review |

## Tasks

1. [ ] Test writer (fresh): test plan below, tests for S-AC-1, S-AC-2 marked `todo`, failing for their reason; commit `test(append): S-AC-1 S-AC-2 append execute span #ttv-260`.
2. [ ] Implementer (fresh): design; S-AC-3; `npm test` exits 0.
3. [ ] Reviewer approves; CI green; merge by rebase after the add-on with the paired proxy is released.

## Test plan

### 1. Scope and risk

1. Files in scope: `public/domain/append-service.js` (`observeHlsAppendService`
   `onAppended`, `AppendService.record`, `AppendService.snapshot`), covered by
   `test/append-service.test.js`.
2. Out of scope: `public/domain/fragment-service.js` (unchanged; its samples
   already carry their marks), `public/domain/hls-player.js` (wires the
   observers and is unchanged), the net report that carries the snapshot to
   the proxy (unchanged: it sends the snapshot as it is), and the proxy's
   validation of `executeMs` (proxy change `browser-fragment-processing`,
   AC-9).
3. Risk areas and depth:
   1. Append telemetry (high: the proxy's readiness schedule charges what this
      field says). Every positive, negative and boundary case of part 3.
   2. The existing sample fields (`elapsedMs`, identity fields): low. The
      positive case asserts the whole sample, so a change to any other field
      fails it.

### 2. Types and levels

All unit, `node:test`, the module with a fake hls.js event emitter (the
`Events` class of the test file) and an injected clock:
`node --test test/append-service.test.js`. No integration or end-to-end
level: the field is a value copied from an hls.js event, and its use is the
proxy's (proxy AC-12 checks it end to end on the Home Assistant host).

| AC | level | tests |
|---|---|---|
| S-AC-1 | unit | "an appended event's execute span is recorded as executeMs beside the unchanged elapsed time"; "the execute span is read from the buffer the append went to"; "an append that executed in no measurable time has an execute span of zero"; "a recorded execute span is returned on its sample" |
| S-AC-2 | unit | "an appended event without chunkMeta records the sample with executeMs null"; "an appended event without a buffering entry for its buffer records executeMs null"; "an execute span that never started (executeStart 0) records executeMs null"; "non-finite execute marks record executeMs null"; "an execute span that ends before it starts records executeMs null"; "record stores a negative, non-finite or absent executeMs as null and keeps the sample" |
| S-AC-3 | CI, review | not a test of this plan: the implementer updates the existing tests that pin the old sample shape (below) |

### 3. Case coverage

1. Positive: `executeStart` 105, `executeEnd` 125 on `chunkMeta.buffering.video`
   of a video append gives `executeMs` 20, and the whole sample (bytes,
   `elapsedMs` 30 measured from the appending event, age, identity) is
   otherwise as today; an audio append reads `buffering.audio`, not
   `buffering.video`; `record` with `executeMs` 7 returns 7 on the sample.
2. Negative: no `chunkMeta`; `buffering` without the append's type; marks
   missing, `NaN`, infinite or strings; `executeEnd` before `executeStart`;
   `record` with -1, `NaN`, infinity. Each gives `executeMs: null` and the
   sample is still recorded (the other facts stand).
3. Boundary: `executeStart` 0 (hls.js never started the operation) gives
   null; `executeEnd` equal to `executeStart` (both positive) gives 0;
   `record` without `executeMs` or with `null` gives null.
4. Not covered: the sample-window cut of the snapshot (unchanged, covered by
   the existing first test).

Existing tests that pin the old shape and that the implementer updates under
S-AC-3 (not edited here): "append service sums bytes and acknowledged service
time by stream and data kind" and "invalid and unfinished append work is not
turned into a service rate" deep-equal append samples without `executeMs`.

### 4. Rules and exit

1. Before the code, every new test fails under `node --test
   test/append-service.test.js` (run 2026-11-12 on `dfe3bf3` plus these
   tests: 15 tests, 5 pass, 10 todo, 0 fail). Observed failures:
   S-AC-1 tests: the snapshot sample has no `executeMs` (deep-equal shows the
   missing `executeMs: 20`; `undefined` against 13, 0 and 7). S-AC-2 tests:
   `executeMs` is `undefined`, not `null`, while the sample count and
   `elapsedMs` assertions before it hold.
2. Deterministic: the clock is injected (`now` of `observeHlsAppendService`,
   `completedAt` and `snapshot(at)` of the service); no timers, no network.
3. Nothing in these tests can block; no bound is needed.
4. Exit: `npm test` in the server (lint plus `node --test`).
