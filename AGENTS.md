Read `../AGENTS.md` first. It holds the project-wide rules (a link to `meta/AGENTS.md` made by meta's setup script; a task worktree sees the same link). This file adds only what is specific to this repository.

# server — the web app, signalling and the proxy registry

Runs at https://webauth.courses. It serves the browser app from `public/`
(hls.js from `/vendor`), relays WebRTC signalling between browsers and proxies
(`/ws/browser-signal`, `/ws/proxy-tunnel`), keeps the table of connected proxies
and chooses one per viewer (`/api/proxy-clients/*`), and answers film metadata
and subtitle searches. Video flows browser ↔ proxy and never through here.

## Layout

- `server.js` — Fastify setup and explicit route registration.
- `routes/<path>/<method>.js` — one folder per URL path, one file per method,
  exporting `handle<Name><Method>(req, reply, deps)`. Follow this pattern.
- `services/` — proxy choice and tunnel, signalling hub, reachability probe,
  metadata (`METADATA.md`), subtitles and the server cache (`SUBTITLES.md`).
- `public/` — the browser app: plain ES modules, no bundler. `components/`
  never import each other; they talk through events named in
  `public/shared/events.js` (`public/components/README.md`). `domain/` holds
  the logic, pure where it can be. Which file owns what:
  [`docs/layout.md`](docs/layout.md).
- The browser ↔ proxy playback contract: proxy
  [`docs/browser-proxy-contract.md`](https://github.com/torrent-tv/proxy/blob/main/docs/browser-proxy-contract.md).
- Planned remote access (per-proxy DNS and TLS, endpoint choice, relay) and the
  server's part in it:
  [meta `research/remote-access-direction-2026-07-11.md`](https://github.com/torrent-tv/meta/blob/main/research/remote-access-direction-2026-07-11.md).
  The dial-back reachability probe exists (`services/reachability-prober.js`).

## Markup

No gratuitous wrappers. HTML defines structure and semantics; presentation is
layered on markup that is already semantically and structurally right. Every
new wrapper element must be justified; a wrapper that exists only to hang styles
on means the CSS should be restructured instead.

## The application state machine — keep it correct in every change

`public/domain/app-state.js` defines the eight control states (IDLE,
CHOOSING_FILE, OPENING, ADVANCING, STALLED, SWITCHING, PAUSED, ERROR), the
transition relation and the OPEN/LIVE superstates. It is pure and owns the flow
rules. `public/components/torrent-tv/torrent-tv.js` drives that relation and
publishes state changes; it does not define a second transition table.
`public/shared/state-derived-view.js` lets views derive visibility from the
current state.

Any change that touches application flow keeps the machine correct in the same
change, all three of:

1. The machine — states, transition table, triggers, guards, and which view each
   state shows.
2. The written graph, [`docs/app-state-machine.md`](docs/app-state-machine.md)
   (mermaid): it changes in the same commit as `public/domain/app-state.js`.
   The principles the machine's shape is derived from are stated there.
3. Tests where they are worth writing: the rules are pure and importable, so
   `node --test` exercises them without a DOM (`test/app-state.test.js`).

## What the viewer is told

A message shown to the viewer talks about the film and what the viewer can do
next. It never names a cause that has not been established, never describes our
internal parts and never refers the viewer to a log. When the player itself
reports that it cannot continue, that is what the viewer is told; every other
detail goes to the log (`public/domain/viewer-failure.js`).

## Gotchas

- **The local-network permission request is intentional.** Chromium carries no
  data-channel DATA to a LAN address without Local Network Access, although ICE
  and DTLS succeed; the channel opens, carries nothing and dies within seconds.
  The page asks for the permission by a fetch of
  `http://<proxy-lan-ip>:9090/healthz` with `targetAddressSpace: "local"`
  (`public/domain/local-network-permission.js`); without that option an http
  request from the https page is blocked. Do not remove it: same-LAN playback
  breaks.
- **`a=sctp-init` is stripped from the offer** sent to the proxy
  (`public/domain/transport/signalling-session.js`). Chromium 152+ puts its
  SCTP INIT in the SDP; libdatachannel echoes the attribute, the browser
  believes in an association that never reaches the wire, and the data channel
  dies about 5 s after DTLS. Remove only once libdatachannel handles it.
- **HLS errors go to the console only** (`public/domain/hls-player.js`); never
  show a non-fatal HLS error in the on-screen status.
- **TMDB's terms are not followed**, by the owner's decision of 2026-09-30:
  add no TMDB logo, credit or attribution unless asked
  ([meta `research/metadata-enrichment-2026-09-30.md`](https://github.com/torrent-tv/meta/blob/main/research/metadata-enrichment-2026-09-30.md#tmdbs-terms)).
- `GET /env.js` (`routes/env/get.js`) serves `window.env.version` from
  `package.json`; `index.html` loads it before the app, so the deployed version
  is readable in the browser console.
  The image carries the `package.json` version of the commit it was built from,
  which is that commit's own release.

## Checks and release path

`npm test` runs `biome lint .` and `node --test`. `scripts/check.sh` runs the
same checks as CI one by one: `tools` (Node and npm are the versions of
`.node-version` and `packageManager`), `pins` (every dependency is an exact
version), `test`, `image` (`docker build`; the image runs `server.js --check`
in its last stage), `copies` and `changeset-format` (a pull request carries no
copy of a commit on `main` and adds a changeset of one short plain sentence or paragraph each),
`changesets-selftest` (both on bad input), `workflow-pins` (every action, image, Node version and npm or docker install in a workflow is an exact
version), `workflow-tokens` (the dependency job `update` gives no token to package code, and each job
that pushes holds the App token with the permissions it needs, listed in `WORKFLOW_PUSHES`; it reads the
workflows with yq 4.54.1), `commit-msg-bot` (the dependency job runs the commit-msg hook on each commit
it prepares), `workflow-refs` (the checkouts of the dependency job `update` are at `main`, so a run
queued behind another starts from the tip of `main`), `workflow-selftest` (all four on bad input) and `all`.
`.github/workflows/main.yml` runs the checks, the tests and an image build on
every pull request; `npm ci --ignore-scripts` installs, and no dependency has an
install script.

Changesets, versions, the release and the daily dependency update are shared by
every repository and are written once, in [`../AGENTS.md`](../AGENTS.md) ("Process" rule 10).
What is specific to the server:

- The changeset front matter names `"@torrent-tv/server"`.
- The release builds the image and, for each version, `publish` pushes
  `ghcr.io/torrent-tv/server:<version>` built from that version's commit before
  it tags it. The `install` job then writes the image into `torrent-tv/infra`'s
  `docker-compose.yml`, pushes `chore(deploy): run server <version> #ttv-388`
  there as the release App, and waits until `https://webauth.courses/env.js`
  reports the version.
- `dependencies.yml` pushes `fix(deps)` when the lock file changes what the image
  holds.
- The rules, the states of a commit and the blockers:
  [`openspec/changes/archive/2026-11-11-release-with-changesets/design.md`](openspec/changes/archive/2026-11-11-release-with-changesets/design.md).

The browser cache can hide a change: hard-refresh when checking by hand.
