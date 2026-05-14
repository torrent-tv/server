# Proxy Selector Component

This component encapsulates proxy discovery and scoring.

## Responsibilities

- Fetch available proxy clients from `/api/proxy-clients`.
- Probe each proxy via `/health`.
- Build a weighted score from latency and reported free CPU/bandwidth.
- Return the best proxy base URL for playback preparation.
- Store proxy diagnostics in `window.__TORRENT_TV_DEBUG__.proxies`.

## Notes

- Proxy registration/heartbeat/de-registration are handled on the backend (`torrent-online` server and proxy-client), not in browser UI components.
- This helper is consumed by `loading` only; cross-component coordination remains event-driven via `public/shared/events.js`.
