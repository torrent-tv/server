# local-network-flow — delta spec

## ADDED Requirements

### Requirement: Connect without the local-network permission when possible

The browser SHALL first attempt the WebRTC connection using only the proxy's
public addresses, so no local-network permission question can appear. Only
when that attempt fails SHALL the flow involve the proxy's local addresses —
and before that retry it SHALL obtain the browser's local-network permission
where such a permission exists: explaining why, then letting a single user
click trigger the browser's own question; when the permission is denied it
SHALL show guidance to the site settings with a re-check action. Browsers
without such a permission SHALL retry immediately with no extra UI.

#### Scenario: Same-network viewer, router loops packets back
- **WHEN** a viewer on the proxy's own network connects and their router
  supports reaching the proxy via its public address from inside
- **THEN** playback starts with no permission question

#### Scenario: Same-network viewer, router cannot loop back
- **WHEN** the public-only attempt fails and the permission state is "prompt"
- **THEN** the loading view explains why access is needed and an Allow button
  click makes the browser show its permission question; after a grant the
  connection is retried with local addresses

#### Scenario: Permission previously denied
- **WHEN** the public-only attempt fails and the permission state is "denied"
- **THEN** the loading view shows how to enable it in the site settings and a
  Check-again action re-evaluates the state

#### Scenario: Browser without the permission mechanism
- **WHEN** the public-only attempt fails on a browser with no local-network
  permission (e.g. Firefox)
- **THEN** the connection is retried with local addresses immediately, with
  no extra UI
