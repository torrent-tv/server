# Proposal: Each append sample carries the time the append itself executed

Issues: torrent-tv/meta#260, parent torrent-tv/meta#185.
Paired proxy change: `proxy/openspec/changes/browser-fragment-processing`.

## Why

The page reports every SourceBuffer append to the proxy (`append-service.js`)
with `elapsedMs`, measured from hls.js `BUFFER_APPENDING` to `BUFFER_APPENDED`.
That interval includes waiting: hls.js holds a soundtrack append while the
picture buffer is empty or behind (`buffer-controller.ts`,
`blockAudio(partOrFrag)` in `onBufferAppending`, hls.js 1.7.4), and each append
waits in its SourceBuffer's operation queue. The proxy needs the work alone to
charge the browser's processing of each fragment in its readiness schedule;
charging the waits would count the picture's production again as sound
processing.

hls.js already measures the work: `chunkMeta.buffering[type].executeStart` is
set when the append operation starts executing and `executeEnd` when its
`updateend` completes (`execute` and `onComplete` of the append operation);
`BUFFER_APPENDED` carries that `chunkMeta`.

## What changes

`observeHlsAppendService` reads `data.chunkMeta.buffering[data.type]` at
`BUFFER_APPENDED` and records `executeMs = executeEnd - executeStart` when both
are finite, positive and ordered; otherwise `executeMs` is `null`. The sample
and the snapshot carry it. Nothing else changes; `elapsedMs` stays.

## Out of scope

Using the value: the proxy change. Fragment parse samples
(`fragment-service.js`) already carry their marks.

## Release

After the add-on that carries the paired proxy (meta AGENTS.md "Process" rule 3).
The proxy ignores a sample without `executeMs`, so the order is safe either way.
