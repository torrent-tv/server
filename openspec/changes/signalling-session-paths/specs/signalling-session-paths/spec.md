# signalling-session-paths — delta spec (server and page)

## ADDED Requirements

### Requirement: A message before the session is ignored (S1)
`SignallingSession` SHALL ignore every message other than `session` until the
`session` message has created its peer. The ignored message SHALL NOT throw,
SHALL NOT send an offer, SHALL NOT be buffered and SHALL NOT fail the connect.
This holds for the media peer and for the control peer.

#### Scenario: An answer and a candidate arrive first
- **WHEN** an answer and a candidate arrive before `session`
- **THEN** nothing is sent, nothing is applied
- **AND** when `session` then arrives the offer is sent and the handshake proceeds, without the early candidate

### Requirement: A socket that is not open fails the connect at once (S2)
When the offer is to be sent and the socket is not OPEN, `SignallingSession`
SHALL call `onFail` once with an error saying signalling is not open, and
SHALL send nothing. The media connect and the control connect SHALL then fail
without waiting for their timeout.

#### Scenario: Not open at the session message
- **WHEN** `session` arrives while the socket's `readyState` is not OPEN
- **THEN** `onFail` is called once and no offer is sent

### Requirement: The offer span is ended on every exit path (S3)
The function returned by `trace("offer")` SHALL be called exactly once,
whether the offer is sent, creating or sending it throws, or the session is
closed while the offer is being created or its local description set.

#### Scenario: The socket closes while the offer is created
- **WHEN** the socket closes and the owner closes the session while `createOffer()` is pending
- **THEN** the span's end function has been called once when `createOffer()` settles

### Requirement: No `onAnswered` option (S4)
`SignallingSession` SHALL NOT accept, read or call an `onAnswered` option, and
no file under `public/` SHALL mention it.

#### Scenario: Answer applied
- **WHEN** an answer is applied
- **THEN** a supplied `onAnswered` is not called
