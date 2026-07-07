# Proposal: Prompt-free-first local-network flow

## Why

Chromium asks the user before a web page may talk to addresses inside their
own network (the Local Network Access permission). Our WebRTC connection used
the proxy's local address directly, so every same-LAN viewer on Chromium got
the browser's permission question with no explanation — and a denial (hard to
undo) or a dismissed question left playback broken. Firefox has no such
mechanism and never asks. The permission question is the browser's own UI and
cannot be avoided when a local address is touched — but it CAN be avoided by
not touching one.

## What Changes

- **Attempt 1 — public addresses only** (no permission question possible):
  the proxy's local-address ICE candidates are dropped; a same-LAN viewer
  connects through the router's public side when the router can loop packets
  back inside (hairpin — most home routers can). Shorter connect timeout
  (12 s): the public path works within seconds or never.
- **Attempt 2 — with local addresses**, only when attempt 1 failed. Before
  retrying, the flow obtains the permission where the browser has one:
  - state `prompt`: explainer on the loading view + an "Allow" button whose
    click performs the local request (`fetch` with
    `targetAddressSpace: "local"`) that makes the browser show its question;
  - state `denied`: guidance to enable "Local network" in the site settings +
    a "Check again" button;
  - `granted` / no such permission (Firefox): retry immediately, no UI.
- Loading view gains one hidden action button for such mid-flow user actions.

## Capabilities

### Modified Capabilities

- WebRTC transport acquisition (client side): two-stage candidate policy +
  permission walkthrough.

## Impact

- `public/domain/webrtc-proxy.js` — `allowPrivateCandidates` policy, local
  address classification, `lanProbeUrl`, per-call connect timeout.
- `public/domain/local-network-permission.js` (new) — permission query +
  probe.
- `public/components/proxy-selector/proxy-selector.js` — options threading.
- `public/components/loading/loading.js`, `index.html` — two-stage acquire +
  action button.
- Server-only release; no proxy/addon change.
