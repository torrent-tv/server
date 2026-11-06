# one-way-per-task — delta spec (server and page)

## ADDED Requirements

### Requirement: One readiness verdict (#289)
The page SHALL decide from `playbackReadiness` whether to release the picture
only through `public/domain/readiness-gate.js`, at start and after a seek. A
missing version or null readiness SHALL NOT release the picture.

#### Scenario: Superseded answer after a seek
- **WHEN** the proxy answers a seek with `playbackReadiness: null`
- **THEN** the picture stays held, as it would at start

### Requirement: Picker errors are shown where the input is (#290)
The picker SHALL report an unusable file, URL or magnet through constraint
validation on its own input and SHALL NOT dispatch `ERROR_EVENTS.SHOW`.

#### Scenario: A video file dropped on the picker
- **WHEN** a `.mkv` is dropped
- **THEN** the file input carries a validation message and the state stays IDLE

### Requirement: One transcode plan (#297)
Copy or transcode for each track and the segment format SHALL be decided by
`transcodePlan` in `public/domain/transcode-plan.js` on every path.

#### Scenario: Same file, same plan
- **WHEN** one file is opened through the data channel and through the web-seed fallback
- **THEN** both paths choose the same copy/transcode per track

### Requirement: One open flow and one magnet parser (#298)
A .torrent and a magnet SHALL be opened through one flow after their
preludes; magnets SHALL be parsed only by `public/domain/magnet.js`.

#### Scenario: Base32 magnet
- **WHEN** a base32 btih magnet is pasted
- **THEN** the page asks for the proxy that holds the film, as it does for the .torrent

### Requirement: One reading of proxy refusals (#299)
Retryability, pending polls, delays and abort detection SHALL be decided by
`public/domain/proxy-answer.js` and `public/shared/`.

#### Scenario: Absent canRetry
- **WHEN** a refusal has no `canRetry` and status 409
- **THEN** every path treats it as not retryable

### Requirement: One signalling session (#312)
Both WebRTC peers SHALL run the signalling handshake through one session
object; the legacy shared control path SHALL be removed.

#### Scenario: One copy of the SDP fix
- **WHEN** `public/` is searched for `sctp-init`
- **THEN** one place matches

### Requirement: Contract literals once; one registration path (#313)
Message types, header names, outcomes, versions, codec names and limits
shared with the proxy SHALL be defined in `public/shared/proxy-contract.js`;
a proxy SHALL register only through its tunnel.

#### Scenario: Outcome string
- **WHEN** `public/` is searched for `"output-unavailable"`
- **THEN** only `proxy-contract.js` matches

### Requirement: Shared view helpers and colour tokens (#314)
Dialog visibility, panel open state, `[evt]` lines and hex encoding SHALL use
helpers in `public/shared/`; player colours SHALL come from `css/theme.css`
tokens.

#### Scenario: Palette literal
- **WHEN** component stylesheets are searched for `#141416|#f2f2f2|#bbb|#c00`
- **THEN** nothing matches

### Requirement: Shared test fakes (#315)
Server tests SHALL build DOM, fetch and signalling fakes from `test/support/`.

#### Scenario: No private DOM
- **WHEN** `test/` is searched for `class Node extends EventTarget`
- **THEN** only `test/support` matches
