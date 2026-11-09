## Why

torrent-tv/meta#302 (sub-issue 16.22 of #279). The full change, with the
proxy and add-on parts, is `proxy/openspec/changes/native-build-one-script/`.

"The image builds and starts" is checked inside the add-on Dockerfile, in a CI
step for the proxy, and not at all for the server: its image is first built by
the release job, which pushes it. A Dockerfile, `.dockerignore` or dependency
change that leaves the server unable to load is found only when the new slot
fails to start on the droplet, after the release is already tagged and written
into `infra`.

## What Changes

- `node server.js --check` loads every module of the server and registers
  every route and plugin, then exits 0 without listening on any port and
  without starting the instance role.
- The final stage of `Dockerfile` runs `node ./server.js --check`, so an image
  that cannot load the server fails to build.
- `.github/workflows/main.yml` gains a `build` job (`Image build`, needs
  `checks`) that builds the image; `release` needs `[checks, build]`.
- `CHANGELOG.md` `## Unreleased` entry.

## Impact

`server.js`, `Dockerfile`, `.github/workflows/main.yml`, `CHANGELOG.md`.
