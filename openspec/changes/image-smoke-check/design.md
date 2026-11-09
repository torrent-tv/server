## Context

`server.js` (at `cb5d277`) builds the Fastify app at module top level: it
imports every route and service, creates the stores, registers plugins and
routes, then, in a final top-level `try`, picks a port with `get-port`,
calls `app.listen` and `role.start()`.

## Decisions

### 1. `--check`

When `process.argv` includes `--check`, `server.js`, right before the final
`try` that picks the port (after every route and plugin is registered):

1. `await app.ready()` — runs every plugin registration;
2. prints `[server] check: every module loaded; not listening` to stdout;
3. `await app.close()` and `process.exit(0)`.

It never calls `getPort`, `app.listen` or `role.start()`. A failure while
loading or in `app.ready()` exits non-zero (an uncaught rejection at top
level, as today). No other argument is parsed.

### 2. `Dockerfile`

In the final stage, after `USER app`:

```
RUN node ./server.js --check
```

(`ENTRYPOINT` is not involved in `RUN`, so the volume copy does not run.)

### 3. CI

`.github/workflows/main.yml`:

```
  build:
    name: Image build
    needs: checks
    runs-on: ubuntu-26.04
    steps:
      - uses: actions/checkout@v7
      - name: Build the image for amd64
        run: docker build -t torrent-tv-server .
```

and `release.needs: [checks, build]`. A pull request whose Dockerfile is
broken fails `Image build`.

## Acceptance criteria

- AC-S1: `node server.js --check` exits 0, prints the check line, never
  prints `[server] Listening on` and leaves no port listening. Checked by a
  server test that spawns it with `PORT` set to a free port and verifies the
  exit code, output, and that the port is still free afterwards.
- AC-S2: a failing module load makes `--check` exit non-zero. Checked by
  the same test file only if it can be shown without editing source files;
  otherwise by the broken-Dockerfile pull request (AC-S4).
- AC-S3: the final stage of `Dockerfile` runs `node ./server.js --check`;
  the workflow has job `build` that runs `docker build`, and `release` needs
  it. Checked by a static test of `Dockerfile` and `main.yml`.
- AC-S4: a deliberately broken Dockerfile fails `Image build` on a pull
  request (throwaway PR, closed after); `Image build` is green on merged
  `main`.

## Out of scope

Publishing or scanning the image; the release job's own build; `public/`.
