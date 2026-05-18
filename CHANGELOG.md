## 0.1.1

- **Fix**: Docker volume stale static files — added `docker-entrypoint.sh` that syncs `/app/public` from the image into the shared nginx volume on every container start. Nginx now always serves fresh JS/HTML after an image update without manual volume removal.
- **Fix**: `npm run docker:build` on Windows — added `.npmrc` with `script-shell=bash` so `$npm_package_version` expands correctly in npm scripts when running under Git Bash.
- **Chore**: `infra/docker-compose.yml` volume mount moved from `/app/public` to `/app/public-volume` so the volume no longer shadows image files.
- **Chore**: `infra/prod.sh` updated to `pull` then `up --remove-orphans` for cleaner deploys.

## 0.1.0

- **New**: WebRTC signalling server — replaced direct HTTP proxy registration with a WebSocket tunnel endpoint. The server brokers SDP offer/answer and ICE candidates between browser and proxy; all video data flows directly over the WebRTC data channel.
- **New**: `npm run patch / minor / major` scripts — bump the package version, build and push a versioned Docker image (`ghcr.io/torrent-tv/server:<version>` + `:latest`), and push git tags in one command.
