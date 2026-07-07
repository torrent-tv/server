# Tasks: Prompt-free-first local-network flow

## 1. Client (this change)

- [x] 1.1 WebRtcProxy: `allowPrivateCandidates` policy (drop local-address
      candidates in public-only mode), `lanProbeUrl` capture, per-call
      connect timeout
- [x] 1.2 `local-network-permission.js`: query state
      (granted/prompt/denied/unsupported) + probe with
      `targetAddressSpace: "local"`
- [x] 1.3 Proxy selector: thread options; attach `lanProbeUrl` to the
      connect error; close the failed attempt
- [x] 1.4 Loading: two-stage `#acquireTransport`; explainer + Allow button
      (click performs the probe → browser shows its question); denied
      guidance + Check again; cancel honoured
- [x] 1.5 Syntax + module-load verified in preview

## 2. Release

- [ ] 2.1 CHANGELOG + server patch (0.8.54)
- [ ] 2.2 Field: same-LAN Chromium with hairpin router connects with NO
      permission question; non-hairpin path walks the explainer flow;
      Firefox unaffected
