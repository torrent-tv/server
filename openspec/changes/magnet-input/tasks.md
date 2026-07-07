# Tasks: Magnet link input

## 1. Implementation

- [x] 1.1 Proxy groundwork: `GET /api/sources/:key/files` (shipped early in
      proxy 2.9.26, change `track-selection`)
- [x] 1.2 torrent-parser: `normalizeRemoteFileList` (proxy inventory → local
      parser shape) and `classifyMediaFiles` (video/audio/subtitles groups)
- [x] 1.3 torrent-session: `openMagnetDetails` (minimal magnet `current`;
      registerSourceOnProxy was already source-type-agnostic)
- [x] 1.4 Picker: magnet text field (rem/tokens styling), Enter/submit flow,
      magnet TEXT paste (files keep priority), `?magnet=` URL param,
      invalid-input error
- [x] 1.5 loading: `#processMagnetPlayback` — register → files route with
      180 s timeout → normalise/classify → rejoin the torrent flow; cancel
      checkpoints; `dn` display name
- [x] 1.6 torrent-tv: MAGNET_READY orchestration; video count tracked from
      SET_MEDIA_FILES (error-screen buttons correct for magnets)

## 2. Verification and release

- [x] 2.1 Preview: field visible and clears on submit, PROCESS_MAGNET fires,
      loading titled from `dn`, metadata status shown; invalid input shows
      the explanatory error; modules load clean
- [ ] 2.2 CHANGELOG at current version + 1 patch; release server
- [ ] 2.3 Field E2E after addon 0.2.48: magnet built from a known infoHash
      lists files and plays
