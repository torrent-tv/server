# Proposal: Close the untaken paths of the signalling session

Follow-up of torrent-tv/meta#312 (one WebRTC signalling session).
`public/domain/transport/signalling-session.js` is shared by the media peer
(`public/domain/webrtc-proxy.js`) and the control peer
(`public/domain/transport/control-connection.js`).

## Why

1. The offer's tracing span is opened before the offer is created and is ended
   only when the offer is sent or throws. When the session is closed (its
   socket dropped, or its owner called `close()`) while the offer is being
   created or its local description set, the session returns without ending the
   span, so the wait trace shows an offer that never finished.
2. The `onAnswered` option is read by one caller, the media peer, which also has
   the answer's effects spread over a hook and the session. Control passes none.
   The option is removed so the answer has one path.
3. Two paths of the session have no test: a message other than `session` before
   `session`, and a socket that is not open when the offer is sent.

## What changes

| Id | Change |
|----|--------|
| S1 | Pinned: a message other than `session` before `session` is ignored on both peers. |
| S2 | Pinned: a socket not OPEN at `#sendOffer` fails the connect through `onFail`, once, on both peers. |
| S3 | The `end` function returned by the `trace("offer")` hook is called exactly once on every exit path of `#sendOffer`, including a close during creation or during setting the local description. |
| S4 | `onAnswered` is no longer accepted by `SignallingSession`, read by it, or passed by any caller. |
