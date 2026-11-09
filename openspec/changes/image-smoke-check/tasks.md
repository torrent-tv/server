## 1. Test plan

Written by the test writer before any test. Covers AC-S1 to AC-S3.

### 1.1 Scope and risk

Files in scope and the tests that cover them:

| File | Test |
|---|---|
| `server.js` (`--check`) | `test/server-check.test.js` (spawns `node server.js --check`) |
| `Dockerfile` (final stage) | `test/image-build.test.js` (reads it as text) |
| `.github/workflows/main.yml` (job `build`, `release.needs`) | `test/image-build.test.js` (reads it as text) |

Out of scope, not tested here:

- `CHANGELOG.md`: CI's `check-changelog` checks the `## Unreleased` entry.
- `.dockerignore` and `docker-entrypoint.sh`: unchanged; whether the image
  holds what the server loads is exactly what the Dockerfile's own
  `--check` proves on GitHub (AC-S4).
- A real `docker build` and the throwaway pull request with a broken
  Dockerfile (AC-S4): run on GitHub by the coordinator.
- The release job's own image build and push: unchanged.

Depth per risk area:

- **Server start-up (medium):** `--check` must load everything and then
  never listen or take the instance role; a mistake either hides a broken
  image or starts a server inside `docker build`. Main positive case, the
  never-listens negatives, and one load failure.
- **Image and CI wiring (release scripts, low):** text checks of the
  Dockerfile and the workflow; main positive case and one negative.
- **Torrent startup:** none; the server has no torrent dependency.

### 1.2 Types and levels

All `node:test`, each file run with `node --test test/<name>.test.js`.

- AC-S1: integration at the process edge — `server-check.test.js` spawns
  `node server.js --check` from the repository root with `PORT` set to a port
  found free on this machine, and without `SERVER_PEER`, `SERVER_CACHE_DIR`,
  `STATIC_*` or provider keys in its environment, so nothing outside the
  process is reached. If the child prints `[server] Listening on`, the test
  kills it at once.
- AC-S2: the same file, same level: a load failure made through the
  environment (`SERVER_CACHE_MIB=1`, which `server.js` refuses at load),
  without editing any source file.
- AC-S3: unit, static — `image-build.test.js` reads `Dockerfile` and
  `.github/workflows/main.yml` as text.
- AC-S4: on GitHub only (coordinator, tasks 4.1).

### 1.3 Cases

`node server.js --check` (AC-S1, AC-S2):

- positive: exits 0 by itself;
- positive: prints `[server] check: every module loaded; not listening` on
  stdout;
- negative: never prints `[server] Listening on`;
- negative: exits by itself (is not killed) and the port named by `PORT` is
  free afterwards;
- negative (AC-S2): with `SERVER_CACHE_MIB=1` it exits non-zero and prints
  neither the check line nor `[server] Listening on`.

`Dockerfile` and `main.yml` (AC-S3):

- positive: the final stage runs `node ./server.js --check`, after
  `USER app`;
- negative: the `--check` run is not in the `dependencies` stage but in the
  final one, where the server runs (covered by the stage the positive case
  reads; no separate test);
- positive: job `build` is named `Image build`, needs `checks`, and runs
  `docker build`;
- positive: `release` needs both `checks` and `build`.

Boundary and deliberately not covered:

- the ports `PORT+1 … PORT+50` that `get-port` would try: not probed; the
  absence of `[server] Listening on` already shows no `app.listen` ran;
- `role.start()` not running: no observable effect without `SERVER_PEER`
  beyond listening, so it is covered by the same never-listens cases;
- a failure inside `app.ready()` (as opposed to at load): cannot be made
  without editing a source file; AC-S4 covers it on GitHub;
- other arguments next to `--check`: the design parses no other argument.

### 1.4 Rules and exit

- Every new test fails before the code exists, for the AC's reason:
  - `server-check.test.js`: `server.js` ignores `--check`, listens on
    `PORT`, prints `[server] Listening on` and is killed, so it neither exits
    0 by itself nor prints the check line. The AC-S2 case passes before the
    code: a load failure already exits non-zero today, and the test guards
    that `--check` keeps it so.
  - `image-build.test.js`: the final stage has no `--check`, there is no job
    `build`, and `release` needs only `checks`.
  Command: `node --test test/server-check.test.js test/image-build.test.js`.
- Deterministic: no sleeps; the only network is a port of this machine; each
  test's run is independent of order; the one child process is killed if it
  ever listens, and has a timeout as a guard.
- One behaviour per test, named as a sentence.
- Exit: `npm test` exits 0 (lint plus every test).

## 2. Tests (failing, one commit)

- [ ] 2.1 Tests from the plan, committed failing: `test(server): …`

## 3. Implementation

- [x] 3.1 `server.js --check` as in design Decision 1
- [x] 3.2 `Dockerfile` final stage runs it
- [x] 3.3 CI `build` job; release needs it
- [x] 3.4 `CHANGELOG.md` `## Unreleased` entry
- [x] 3.5 `npm test` exits 0

## 4. After merge (coordinator)

- [ ] 4.1 Throwaway PR with a broken Dockerfile fails `Image build` (AC-S4)
