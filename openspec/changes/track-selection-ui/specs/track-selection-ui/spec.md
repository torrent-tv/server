# track-selection-ui — delta spec

## ADDED Requirements

### Requirement: Audio track menu
The player settings menu SHALL show an Audio submenu when the active file
has more than one audio track, labelled from the track's language and title
metadata. Selecting a track SHALL replay the same file with that track
mapped by the proxy and SHALL preserve the playback position. With one (or
zero) audio tracks the settings button SHALL stay hidden.

#### Scenario: Multi-audio file
- **WHEN** playback starts for a file with two audio tracks
- **THEN** the settings menu lists both with readable labels and the active
  one marked

#### Scenario: Switching audio
- **WHEN** the viewer picks the second track at position T
- **THEN** playback restarts through the proxy with that track and resumes
  near T

### Requirement: Embedded subtitles in the captions menu
Embedded TEXT subtitle tracks SHALL be fetched from the proxy after playback
starts (sequentially, with a timeout that accommodates full-file extraction)
and attached as subtitle tracks alongside external subtitle files.
Image-based tracks SHALL be skipped. Failures SHALL be console-only.

#### Scenario: MKV with an embedded ASS track
- **WHEN** playback starts for an MKV with an embedded English ASS subtitle
- **THEN** the captions menu eventually lists it (e.g. "English — BD_OCR")
  and selecting it renders cues

### Requirement: Graceful degradation on older proxies
Against a proxy without track inventory the UI SHALL behave exactly as
before: no settings button, no embedded subtitles, no errors.

#### Scenario: Pre-2.9.26 proxy
- **WHEN** the playback plan carries no track arrays
- **THEN** playback proceeds with the default track and only external
  subtitles
