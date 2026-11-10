# Tasks: Close the untaken paths of the signalling session

Parent: torrent-tv/meta#312 (follow-up). Acceptance criteria S1 to S4 are in
`specs/signalling-session-paths/spec.md`.

## 1. Implementation (implementer)

- [ ] 1.1 S3: end the `trace("offer")` span on the two `if (this.#closed) return;` exits of `#sendOffer`
- [ ] 1.2 S4: remove `onAnswered` from `SignallingSession` (option, JSDoc, call in `#applyAnswer`) and move
      what the media peer does after the answer out of the option, keeping every behaviour of
      `test/webrtc-signalling-handshake.test.js` and `test/webrtc-control-connection.test.js`
- [ ] 1.3 Remove the `todo` markers of the tests that pass; `npm test` exits 0

## 2. Test plan

### 2.1 Scope and risk

Files in scope and their tests:

| File | Tests |
|------|-------|
| `public/domain/transport/signalling-session.js` | `test/signalling-session-paths.test.js` (direct, S1 to S4), `test/signalling-single-source.test.js` (S4 scan) |
| `public/domain/webrtc-proxy.js` (media peer) | `test/signalling-session-paths.test.js` through `WebRtcProxy.connect()` (S1, S2) |
| `public/domain/transport/control-connection.js` (control peer) | `test/signalling-session-paths.test.js` through `ControlConnection.open()` (S1, S2) |

Out of scope: the rest of the handshake (answer, candidates, filtering,
`a=sctp-init`), already pinned by `test/webrtc-signalling-handshake.test.js` and
`test/webrtc-control-connection.test.js`; the server's signalling relay
(`services/signal-hub.js`), untouched; the contents of the wait trace spans
(`waitTrace`), only the hook's `end` call is the subject.

Risk: WebRTC signalling is the viewer's first step; a failure there is shown as
"no proxy answered". Depth: S1 and S2 high (both peers, each asserted for
nothing-sent and for the outcome); S3 high (three exits); S4 low (one static
scan, one behavioural case). Nothing touches torrent startup: the tests import
only browser code (`public/domain/*`) with fake `WebSocket` and
`RTCPeerConnection`; the server has no torrent code.

### 2.2 Types, levels, commands

All `node:test`. Unit and integration, no end-to-end (the paths need a socket
that is closed or not open, which a real proxy cannot be made to produce on
demand; the real handshake stays covered by `ha-field-check`).

- Run the new tests: `node --test test/signalling-session-paths.test.js test/signalling-single-source.test.js`
- Full pass/fail command (what CI runs): `npm test` (`biome lint .` then `node --test`)

| AC | Test (file) | Level | State before the code |
|----|-------------|-------|-----------------------|
| S1 | media and control, early messages ignored; handshake proceeds after `session` (4 tests, `signalling-session-paths`) | integration through `WebRtcProxy` and `ControlConnection` | passes: pin, not `todo` |
| S2 | session reports one failure; media connect rejects; control connect rejects once (3 tests) | unit and integration | passes: pin, not `todo` |
| S3 | sent offer ends once; failed offer ends once as error; socket closed during creation, no owner close: ends once (3 tests) | unit | passes: pin, not `todo` |
| S3 | owner closes the session after the socket closes, during `createOffer`; the same during `setLocalDescription`; owner `close()` during `createOffer` (3 tests) | unit | fails, `todo: S3`: end function called 0 times, expected 1 |
| S4 | session does not call a supplied `onAnswered` (`signalling-session-paths`) | unit | fails, `todo: S4`: the option is called with the answer |
| S4 | no mention of `onAnswered` under `public/` (`signalling-single-source`) | static scan | fails, `todo: S4`: 4 mentions (session JSDoc and call, `webrtc-proxy.js:530`) |

### 2.3 Case coverage

- Positive: offer sent, span ended as `sent`; handshake proceeds after an early
  message; answer applied without `onAnswered`.
- Negative: message before `session` (answer, candidate, unknown type, with
  `separateControl`, with the control's connection id); socket in `readyState`
  0 at the offer; `createOffer` throws; socket closed or session closed during
  `createOffer` and during `setLocalDescription`.
- Boundary: the first message of the session being a non-`session` one; the
  early candidate is not replayed after the answer; the span ended exactly once
  (not zero, not twice).
- Not covered: `readyState` 2 (CLOSING) and 3 (CLOSED), the code tests only for
  `!== OPEN`, so one value stands for all; a close during `send` itself,
  because `send` is synchronous.

### 2.4 Rules and exit

- Each new `todo` test fails before the code for its AC's reason (table above);
  the command is the one above, outcome listed under "failing tests" with
  `# S3` or `# S4`.
- No timers: tests wait for events through `setImmediate` and promises held by
  the test; the two tests that await a rejection carry `timeout: 5000` as a
  backstop only.
- Mutants checked against the unchanged code: removing `if (!this.#pc) return;`
  fails the four S1 tests; removing the `Signalling is not open` throw fails the
  three S2 tests.
- Exit: `npm test` exits 0 before and after the implementer's commit.
