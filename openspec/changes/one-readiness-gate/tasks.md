# Tasks: One readiness verdict (torrent-tv/meta#289)

## Acceptance criteria

- **AC-1** `grep -rn "version === 1\|version !== 1" public` lists only
  `public/domain/readiness-gate.js` (and `public/domain/chapter-metadata.js`,
  the chapter answer's own contract — out of scope, design §6).
  Checked: the grep, run by the reviewer and in a test (unit, below).
- **AC-2** One table — `null`, `undefined`, version 0, version 1 ready,
  version 1 not ready, stale, `media-continuity-unavailable` — gives the same
  outcome through `readinessVerdict`, through `#waitForPrebuffer` and through
  `#holdSeekUntilReady`. Checked: `node --test` (unit + method-level, below).
- **AC-3** Field: deployed site, HA proxy, one MKV from the Dropbox `trn`
  folder, five seeks; after each, the waiting overlay is released only when
  the picture plays on: no `STALLED` within 3 s after `SWITCHING → ADVANCING`
  in the client log. Checked: end-to-end on the HA host (below).
- **AC-4** `npm test` exits 0; `CHANGELOG.md` has the `## Unreleased` entry.

## Test plan

### 1. Scope and risk

Files in scope and their tests:

| File | Tests |
|---|---|
| `public/domain/readiness-gate.js` (new) | `test/readiness-gate.test.js` (new): the rule table of design §1 |
| `loading.js` `#waitForPrebuffer` | `test/readiness-gate-callers.test.js` (new): the AC-2 table through the method, extracted from source with fakes as in `test/prebuffer-asks-on-arrival.test.js` |
| `loading.js` `#holdSeekUntilReady` | same file: the AC-2 table through the method, extracted the same way as in `test/seek-readiness.test.js` |
| `public/domain/picture-holds.js` | `test/picture-holds.test.js`: the `seekHoldAnswer` test is removed (function removed); `nextSeekHoldAsk` / `PictureHolds` tests unchanged |
| `components/waiting/waiting.js` | covered by the AC-1 grep test and the existing `test/waiting-screen-readiness.test.js`; no new DOM test (low risk, one boolean, design §5) |
| whole `public/` | AC-1 grep test in `test/readiness-gate.test.js` (reads files under `public/`, excluding `vendor/`) |

Existing tests the change makes unrunnable or that encode the removed rule are
updated by the test writer in the test commit: `test/picture-holds.test.js`
(`seekHoldAnswer` import and the `null → release` case) and any method-level
test that builds `#waitForPrebuffer` / `#holdSeekUntilReady` with `new Function`
and must now receive `readinessVerdict` as a parameter
(`test/prebuffer-asks-on-arrival.test.js`, `test/seek-readiness.test.js`):
they pass the real `readinessVerdict` when the module exists and otherwise
fail on its absence, like the new tests.

Out of scope: `waiting-model.js`, `waiting-text.js`, `subtitle-start.js`
(called, not changed); `chapter-metadata.js` (other contract); the proxy.

Risk areas and depth:

- State machine / waiting model — **high**: the hold decides when `SWITCHING`
  ends. Every case of part 3 for both callers.
- HLS delivery, WebRTC, disk, release scripts — not touched.
- Torrent startup — not reached: page code only, no proxy test.

### 2. Levels and commands

- Unit: `node --test test/readiness-gate.test.js` — AC-1, rule table.
- Method-level integration (real method text, fakes for session, video,
  trace, timers): `node --test test/readiness-gate-callers.test.js` — AC-2.
- End-to-end: AC-3 only, on the HA host per `meta/docs/ha-browser-mcp-testing.md`
  with the deployed site; never on this Mac. Steps: open an MKV `.torrent` from
  `/Users/silentimp/Library/CloudStorage/Dropbox/trn` on the HA proxy, wait
  for playback, seek five times to positions not yet buffered (e.g. 10 %,
  30 %, 50 %, 20 %, 70 %), each after the previous one plays; download the
  client log; pass = after every `SWITCHING → ADVANCING` no `STALLED` within
  3 s, and the overlay was shown during each hold. Close the tab after.
- Exit: `npm test`.

### 3. Cases

`readinessVerdict` (unit):

- positive: v1 ready → release with the proxy's reason; v1 not ready →
  wait with its reason; v1 ready + `subtitleHold: "subtitles-pending"` → wait
  `subtitles-pending`; v1 ready + `subtitleHold: "proxy-unaware"` → release.
- negative: `null` → wait `forecast-missing`; `undefined` → same; a string or
  number → same; version 0 / 2 / missing → wait `forecast-version-unsupported`;
  `media-continuity-unavailable` (with `ready: false`) → fail; v1 not ready
  without reason → wait `forecast-unavailable`.
- boundary: `requestedAt === reportedAt` → not stale; `requestedAt` one below
  → stale; `requestedAt` missing with `reportedAt` given → stale; `reportedAt`
  omitted → never stale; stale + `media-continuity-unavailable` → stale (not
  fail); v1 ready without reason → release `ready`; input not mutated; called
  with no argument → wait `forecast-missing`.
- AC-1 grep over `public/` (excluding `vendor/` and `chapter-metadata.js`):
  only `readiness-gate.js` matches.

Callers (method-level), for each AC-2 row, start then seek:

- start: v1 ready → resolves (released); not ready / null / undefined /
  version 0 → keeps polling (does not resolve within the faked turns) and
  publishes the readiness; continuity → rejects with the timestamp-gap message.
- seek: v1 ready → seek owner released, no failure; not ready / null /
  undefined / version 0 → still held after the answer and asks again;
  continuity → `#failWith` called with the timestamp-gap message and the seek
  owner released; stale (requested before `reportedAt`) → not read, asks again.
- boundary: seek hold with a `null` answer followed by a v1 ready answer →
  released only after the second answer.

Not covered: the overlay text after a seek (owned by #288's tests); real
timers (fake clock / injected `setTimeout` only).

### 4. Rules and exit

- Before the code exists every new test fails because
  `public/domain/readiness-gate.js` does not exist or the methods still use the
  old rule (e.g. the seek with `null` is released) — not a typo. Record the
  command and the failure in the test commit's run.
- Deterministic: no real timers or network; fakes only.
- One behaviour per test, named as a sentence.
- Exit: `npm test` exits 0 after the implementation.

## Steps

- [x] 1 Test commit `test(page): AC-1 AC-2 …` (fresh test writer)
- [x] 2 Implementation commit `fix(page): … #ttv-289` (fresh implementer from the test commit)
- [x] 3 Review (`torrent-tv-reviewer`), merge by rebase, release, deploy
- [x] 4 AC-3 field check on the HA host
