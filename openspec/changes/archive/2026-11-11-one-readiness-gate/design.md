# Design: One readiness verdict (torrent-tv/meta#289)

## 1. `public/domain/readiness-gate.js` (new, pure, no DOM)

```js
/**
 * @param {{ readiness?: object | null, requestedAt?: number, reportedAt?: number,
 *   subtitleHold?: string | null }} [answer]
 * @returns {{ verdict: "release" | "wait" | "stale" | "fail", reason: string }}
 */
export function readinessVerdict({ readiness, requestedAt, reportedAt, subtitleHold } = {})
```

Rules, applied in this order; the first that matches decides:

| # | Condition | verdict | reason |
|---|---|---|---|
| 1 | `reportedAt` is a number and `!(requestedAt >= reportedAt)` (also when `requestedAt` is missing or `NaN`) | `stale` | `"asked-before-seek-reported"` |
| 2 | `readiness` is `null`, `undefined` or not an object | `wait` | `"forecast-missing"` |
| 3 | `readiness.version !== 1` | `wait` | `"forecast-version-unsupported"` |
| 4 | `readiness.reason === "media-continuity-unavailable"` | `fail` | `"media-continuity-unavailable"` |
| 5 | `readiness.ready !== true` | `wait` | `String(readiness.reason ?? "forecast-unavailable")` |
| 6 | `subtitleHold === "subtitles-pending"` | `wait` | `"subtitles-pending"` |
| 7 | otherwise | `release` | `String(readiness.reason ?? "ready")` |

Notes:

- `reportedAt` omitted (`undefined`) means "no seek to compare with": rule 1
  never applies. The start gate omits it; the seek gate always passes it.
  `requestedAt === reportedAt` is not stale (as today).
- A stale answer is not read at all, so a stale `media-continuity-unavailable`
  does not fail playback (rule 1 before rule 4).
- `subtitleHold` is the value of `subtitleStartHold(...)` from
  `domain/subtitle-start.js`; any value other than `"subtitles-pending"`
  (`null`, `"proxy-unaware"`, …) does not hold. The function does not call
  `subtitleStartHold` itself.
- The exported reason strings above are the complete set the function
  introduces; callers compare against them, never against `version`.
- The function never throws and never mutates its input.

## 2. `loading.js` `#waitForPrebuffer` (start gate)

Inside step `C1.2.evaluate-readiness`, replace the version/continuity reading:

1. `const first = readinessVerdict({ readiness: proxyReadiness })`.
2. If `first.verdict === "fail"`: `finishSubtitleHold("error")` and throw
   `new Error("Prepared media contains a timestamp gap; playback cannot start.")`
   (same message as today).
3. `subtitleHold = first.verdict === "release" ? subtitleStartHold(startSubtitle, proxyReadiness, cachedProgressRequestedAt) : null`
   — the `proxy-unaware` log and the `C3.subtitle-hold` span stay as they are.
4. `const verdict = readinessVerdict({ readiness: proxyReadiness, subtitleHold })`.
5. The `readiness` published to `WaitingModel` and `PROXY_EVENTS.MEASURED`
   stays as today: the proxy's object, or the subtitles-pending copy
   `{ ...proxyReadiness, ready: false, delaySeconds: null, reason: "subtitles-pending" }`
   when `verdict.reason === "subtitles-pending"`.
6. `verdict.verdict === "release"` → the existing `prebuffer ready …` log,
   `#logColdStart()`, return. Otherwise the waiting log uses `verdict.reason`
   in place of today's `readiness?.version === 1 ? … : "proxy-forecast-unavailable"`.
7. No `version === 1` / `version !== 1` remains in the method.

## 3. `loading.js` `#holdSeekUntilReady` (seek gate)

1. Replace `seekHoldAnswer({ readiness, requestedAt, reportedAt })` with
   `readinessVerdict({ readiness, requestedAt, reportedAt })` inside step
   `S2.2.evaluate-readiness`.
2. `stale` → `continue` (as today).
3. `wait` → as today's wait branch, logging `verdict.reason` on change and
   waiting `#untilMediaArrivesOr(nextSeekHoldAsk(readiness, 1500))`. With
   `readiness` `null`, `nextSeekHoldAsk(null, 1500)` already returns 1500.
   The publish steps S2.3–S2.5 run for `wait`, `release` and `fail` as today
   (for every non-stale answer).
4. `release` → log `seek hold released: forecast ready ahead=… reserve=…` and
   break. The branch "this proxy states no forecast" is deleted: a missing or
   unsupported forecast now waits (contract: it does not authorise playback;
   no compatibility for an earlier proxy).
5. `fail` → log `seek hold: media continuity unavailable`, then
   `this.#failWith(epoch, new Error("Prepared media contains a timestamp gap; playback cannot start."))`,
   then break; S2.7 releases the seek owner as for every other end of the loop.
   `SWITCH_FINISHED` arriving in `ERROR` is an absent edge of
   `domain/app-state.js` and is ignored; no state-machine change.
6. The import of `seekHoldAnswer` goes; `readinessVerdict` is imported from
   `../../domain/readiness-gate.js`.

## 4. `domain/picture-holds.js`

Delete `seekHoldAnswer` and its doc comment. `PictureHolds`, `seekOwner` and
`nextSeekHoldAsk` stay unchanged. Update the file's top comment only where it
names `seekHoldAnswer`.

## 5. `components/waiting/waiting.js`

`readinessUnavailable` becomes
`usable && readinessVerdict({ readiness }).reason === "forecast-version-unsupported"`.
Same truth table as today: `undefined`/`null` readiness → false, an object with
`version !== 1` → true, version 1 → false.

## 6. Other

- `CHANGELOG.md` `## Unreleased`: `- **Fix**: After a seek the picture is held
  until the proxy forecasts it can play on, as at start: an answer without a
  forecast no longer releases it early (followed by a stall), and a timestamp
  gap after a seek fails playback as it does at start.`
- `openspec/changes/one-way-per-task/tasks.md` 1.2 ticked when merged.
- AC-1 grep: `public/domain/chapter-metadata.js` matches `version !== 1` for
  the chapter answer's own contract version. It is not `playbackReadiness`
  and stays; AC-1 is checked with that file excluded (recorded on the issue).
