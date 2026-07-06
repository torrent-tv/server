# proxy-selection — delta spec

## ADDED Requirements

### Requirement: Reachability data in the health API
`GET /api/proxy-clients/health` SHALL include per proxy: `reachable` (last
dial-back probe result; `null` when not probed) and `sameNetwork` (`true`
when the requesting browser's public IP equals the proxy's reported external
IP). The browser's public IP SHALL be taken from `CF-Connecting-IP`, falling
back to the first `X-Forwarded-For` entry, then the socket address.

#### Scenario: Probed proxy
- **WHEN** the browser requests the health list and a proxy has a completed
  dial-back probe
- **THEN** its entry carries the probe result in `reachable`

#### Scenario: Viewer on the proxy's network
- **WHEN** the requesting browser's public IP equals a proxy's reported
  external IP
- **THEN** that proxy's entry has `sameNetwork: true`

### Requirement: Reachable-first selection (preference, not filter)
The selector SHALL prefer candidates with `reachable === true` or
`sameNetwork === true`: the best-scored candidate of that group wins. When
the group is empty, ALL candidates SHALL remain eligible — a failed inbound
TCP probe does not prove WebRTC cannot connect (hole punching), so
unreachable-marked proxies are a fallback, never excluded.

#### Scenario: Reachable node preferred over a better-scored unreachable one
- **WHEN** the pool has an unreachable proxy with a higher resource score and
  a reachable proxy with a lower one
- **THEN** the reachable proxy is selected

#### Scenario: No reachable nodes
- **WHEN** no candidate is reachable or on the viewer's network
- **THEN** selection proceeds over all candidates by score (no empty-pool
  failure)
