# Design: append execute span

hls.js 1.7.4 `src/controller/buffer-controller.ts`: `onBufferAppending` takes
`chunkStats = chunkMeta.buffering[type]`; the queued operation's `execute` sets
`chunkStats.executeStart = self.performance.now()`; `onComplete` sets
`chunkStats.executeEnd = chunkStats.end = end` and then triggers
`BUFFER_APPENDED` with `{ type, frag, part, chunkMeta, parent, timeRanges }`.

`public/domain/append-service.js`:

1. `onAppended(_event, data)`: `const stats = data?.chunkMeta?.buffering?.[data?.type]`;
   `executeMs = Number.isFinite(stats?.executeStart) && Number.isFinite(stats?.executeEnd) &&
   stats.executeStart > 0 && stats.executeEnd >= stats.executeStart ? stats.executeEnd - stats.executeStart : null`.
   Passed to `service.record({ ...append, elapsedMs, completedAt, executeMs })`.
2. `AppendService.record` accepts `executeMs` (default `null`); a value that is
   not `null` and not finite ≥ 0 is stored as `null` (the sample itself is still
   valid: `elapsedMs` and bytes are unchanged facts).
3. `snapshot` adds `executeMs` to each sample.

Both clocks are the page's `performance.now()`; the difference needs no
conversion.

Changeset: `.changeset/<name>.md`, `"@torrent-tv/server": patch`, one sentence.
