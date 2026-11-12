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

To be written by the test writer.
