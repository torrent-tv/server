# Tasks: Audio-track menu and embedded subtitles

## 1. Implementation

- [x] 1.1 torrent-session: plan returns audioTracks/subtitleTracks;
      transcode-session body carries audioTrackIndex
- [x] 1.2 webrtc-proxy: per-request timeoutMs
- [x] 1.3 loading: selection state (+resets), forceAudioRemux fork, plan
      inventory storage, SET_AUDIO_TRACKS dispatch, SELECT_AUDIO_TRACK
      handler with position restore, embedded-subtitle loader (sequential,
      10 min timeout, default-flag handling), track labels
      (ISO 639-2 map + Intl.DisplayNames)
- [x] 1.4 player + index.html: Audio submenu population, radio selection,
      settings-button visibility
- [x] 1.5 Preview verification: menu populates with labels, selection event
      fires and checked state moves, single-track hides the button; modules
      load clean

## 2. Release

- [ ] 2.1 CHANGELOG at current version + 1 patch; release server
- [ ] 2.2 proxy 2.9.26 publish (npm 2FA) + ha-addon 0.2.48 push
- [ ] 2.3 Field test on the owner's MKV (flac audio + embedded eng ASS):
      captions menu gains "English — BD_OCR"; audio menu hidden (single
      track); a multi-audio torrent shows and switches tracks
