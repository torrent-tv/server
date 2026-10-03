# server — public web app + WebRTC signalling

Runs at https://webauth.courses. See the parent `../CLAUDE.md` for the overall
architecture and conventions. This repo is one of three (`server`, `proxy`,
`ha-addon`).

## Responsibilities

- Serve the static frontend from `public/` (Fastify `@fastify/static`), and
  hls.js from `/vendor`.
- WebRTC signalling relay between browsers and proxies (`/ws/browser-signal`,
  `/ws/proxy-tunnel`) plus the proxy registry/health API
  (`/api/proxy-clients/*`). Video itself is P2P browser↔proxy, not via here.

## Layout

- `server.js` — Fastify setup + explicit route registration.
- `routes/<path>/<method>.js` — one folder per URL path, one file per method,
  exporting `handle<Name><Method>(req, reply, deps)`. Follow this pattern.
- `public/` — the browser app (plain ES modules, no bundler). **Markup rule:
  no gratuitous wrappers** — HTML defines structure and semantics,
  presentation is layered on top of markup that is already semantically and
  structurally optimal; every new wrapper element must be justified, and a
  wrapper that exists only to hang styles on means the CSS should be
  restructured instead. Components:
  - `components/loading/loading.js` — playback flow, transport orchestration,
    and per-stream codec decisions.
  - `components/loading/SubtitlePlayback.js` — subtitle track elements, sidecar
    loading, embedded cue delivery, reconnect subscription, remembered
    subtitle choice, and the subtitle menu's items. Each item names its track
    by a key kept for the life of the track (`domain/subtitle-menu.js`), never
    by its label: a label changes once the text has been read. It is the only
    thing that changes a track's mode; the player draws the menu and reports
    the key chosen, and the subtitles key `c` is this page's, not media-chrome's
    (`hotkeys="noc"`).
  - `domain/torrent-session.js` — proxy registration, playback plan, HLS start.
    Seeking is server-side (no client-side session restart).
    The browser and proxy playback contract is documented in
    `../proxy/docs/browser-proxy-contract.md`.
  - `domain/hls-player.js` — hls.js wrapper; HLS errors go to console only.
  - `domain/waiting-signal.js` — the rule that decides whether a `waiting` from
    the media element is a stall the viewer must be told about, or some other
    track being refilled while the picture keeps running (changing a separately
    published audio track). Pure, tested, and the source of `FRAME_BLOCKED`.
  - `domain/webrtc-proxy.js` — WebRTC signalling + PNA health pre-flight
    (the intentional `http://<lan>:9090/healthz` fetch; see parent CLAUDE.md).
  - `components/player/player.js` — player UI; hides the playlist button when
    there is a single media file.

## The state machine — keep it correct, always

`public/domain/app-state.js` defines the application's eight control states
(IDLE, CHOOSING_FILE, OPENING, ADVANCING, STALLED, SWITCHING, PAUSED, ERROR),
the transition relation, and the OPEN/LIVE superstates. It is pure and owns the
flow rules. `public/components/torrent-tv/torrent-tv.js` drives that relation
and publishes state changes; it does not define a second transition table.
`public/shared/state-derived-view.js` lets views derive visibility from the
current state. Flow regressions have included episode-switch-from-error and
mid-loading transport loss.

**Rule: any change that touches application flow keeps the machine correct in
the SAME change.** That means all three of:

1. The machine itself — states, the transition table, triggers, guards, and
   which view each state shows.
2. **The written graph**, `research/state-machine-2026-08-08.md` in the meta
   repo (mermaid, renders on GitHub). It documents every real transition plus
   the known hazards; if a change moves an edge or a view, the note moves with
   it. A graph that has drifted is worse than none.
3. **Tests, where they are worth writing.** The transition rules are pure and
   belong in an importable module so `node --test` can exercise them without a
   DOM — see `public/domain/app-state.js` and `test/app-state.test.js`.

Do not audit the machine once and move on. It is small enough to hold exactly
right, and it is the cheapest lever on the product working reliably.

**Decide its shape from theory, never from what the code currently does.** The
four rules the design is held to, and which any change must respect:

- **Moore** — outputs (which view, the waiting overlay, whether controls accept
  input) are pure functions of the state, derived by each view. Never command a
  view alongside a transition; that is how state and screen come to disagree.
- **Extended state machine** — promote something to a control state only when it
  changes what is legal or what is shown. Everything else is a variable with a
  guard. Never mirror another component's state (`<video>.paused`) as a state.
- **Statechart hierarchy** — an edge shared by several states belongs on their
  superstate, declared once.
- **Graph discipline** — deterministic (one target per state and event), total
  (every pair answered, "ignore" included, never a throw), every state
  reachable, no dead ends. Absent edges are the machine's content: a
  near-complete digraph asserts nothing.

## Notable

- `GET /env.js` (`routes/env/get.js`) serves `window.env.version` from
  `package.json`, so the deployed build is verifiable via the browser console.
  `index.html` loads it before the app scripts.

## Planned: reachability probe + per-proxy certificates (remote access)

Decided direction — full plan in the parent `../CLAUDE.md`, DNS/TLS limits in
`../infra/CLAUDE.md`. Server-side pieces:

- **Dial-back reachability probe** (does not exist yet): when a proxy reports
  its UPnP-mapped endpoint over the tunnel, connect to it from this server and
  only then mark the endpoint verified in the registry. Unverified proxies are
  LAN-only and must not be offered to remote viewers.
- **Per-proxy DNS + certs**: manage `<proxyId>.p.<domain>` records via the
  Cloudflare API (**grey cloud / DNS-only** — never orange; video must not
  flow through Cloudflare), issue per-proxy Let's Encrypt certs via DNS-01
  (`acme-client`), deliver cert+key to the proxy over the tunnel, re-issue
  before the ~90-day expiry.
- **Endpoint candidates in the registry/health API**: return the verified
  HTTPS candidate URLs (public v4/v6; LAN hostname when browser and proxy
  share a public IP — this server sees both sides' public IPs). The browser
  races `/healthz` over the candidates and uses the first responder; WebRTC
  remains the fallback transport.

## Commits

Every commit header follows Conventional Commits (`<type>(<scope>)!: <subject>`,
types `feat fix perf refactor docs test build ci chore style revert`); CI refuses
a pushed commit that does not. Enable the local check once per clone:
`git config core.hooksPath .githooks`. Rules: `torrent-tv/.github` CONTRIBUTING.md.

## Changelog

Every behavioural change must be recorded in `CHANGELOG.md` — add a bullet
under `## Unreleased` at the top (create the heading if it is missing),
following the existing `- **New**/**Fix**/**Chore**:` format. Never write a
version heading and never edit the `package.json` version: the release job
does both. CI refuses a releasable push without an `## Unreleased` entry.

## Deploy

GitHub Actions deploys; nothing is published from a workstation. A push to
`main` runs `.github/workflows/main.yml`: lint and the tests. Then, when the
commits since the last `v*` tag ask for it (`feat` → minor;
`fix`/`perf`/`revert` → patch; anything else → none), the release job in the
`production` environment writes the version and the changelog heading, builds
and pushes `ghcr.io/torrent-tv/server:<version>` and `:latest`, pushes the tag
and the commit, creates the GitHub release, and waits until
`https://webauth.courses/env.js` reports the new version (watchtower rolls the
image out within five minutes). Browser cache can hide changes — hard-refresh
when verifying by hand. A release can also be started from the Actions tab with
an explicit `patch` or `minor` step.

Because the image is built from `package-lock.json`, the daily dependency
update (`.github/workflows/dependencies.yml`) is released as `fix(deps)`.
