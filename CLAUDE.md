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
