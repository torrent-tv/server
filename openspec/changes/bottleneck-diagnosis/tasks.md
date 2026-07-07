# Tasks: Bottleneck diagnosis

## 1. Client symptoms (this change)

- [x] 1.1 Playback tick classifies client-decode vs upstream vs ok from
      buffer trend + dropped-frame ratio (getVideoPlaybackQuality)
- [x] 1.2 Log `[bottleneck]` with buffer level/trend + dropped ratio
      (forwarded to the server log by the client logger)
- [x] 1.3 Syntax + module-load verified in preview

## 2. Release

- [ ] 2.1 CHANGELOG + server patch
- [ ] 2.2 Field: play a heavy file (e.g. MPEG-2/MPEG-4 re-encode) and read
      the `[bottleneck]` lines to see the real limit

## 3. Next (budget stage — separate change)

- [ ] 3.1 On sustained `upstream`, fetch `/progress` (speed) + `/stats`
      (download) and split upstream into proxy-CPU / proxy-download / delivery
- [ ] 3.2 Multi-criteria realtime budget consumes the classification
