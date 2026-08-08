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
  - `components/loading/loading.js` — playback pipeline + per-stream codec
    decision (transcode only what the browser can't play) + console debug.
  - `domain/torrent-session.js` — proxy registration, playback plan, HLS start.
    Seeking is server-side (no client-side session restart).
  - `domain/hls-player.js` — hls.js wrapper; HLS errors go to console only.
  - `domain/webrtc-proxy.js` — WebRTC signalling + PNA health pre-flight
    (the intentional `http://<lan>:9090/healthz` fetch; see parent CLAUDE.md).
  - `components/player/player.js` — player UI; hides the playlist button when
    there is a single media file.

## The state machine — keep it correct, always

`public/components/torrent-tv/torrent-tv.js` is the application state machine:
four states (IDLE, PROCESSING, PLAYING, ERROR), a declared transition table, and
a handful of events that drive it. Every flow bug this project has had landed
here — episode-switch-from-error, mid-loading transport loss.

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
   DOM — follow `public/domain/url-state.js` + `test/url-state.test.js`, which
   is exactly that shape.

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

## Changelog

Every behavioural change must be recorded in `CHANGELOG.md` — add an entry under
a new `## <version>` heading at the top, following the existing
`- **New**/**Fix**/**Chore**:` format.

**Do NOT edit `package.json` version.** Release is `npm run patch` (= `npm
version patch` + docker publish + push), which bumps it. Write the CHANGELOG
entry at the version that bump will produce: **current `package.json` version
+ 1 patch** (or + 1 minor for `npm run minor`). Accumulate bullets into that
single pending entry until it's published. See the parent `../CLAUDE.md`.

## Deploy

Commit + push to `main`; the container image rebuilds and watchtower rolls it
out. Confirm live with `window.env.version`. Browser cache can hide changes —
hard-refresh when verifying.
