# Tasks: Install the pinned yq

Parent: torrent-tv/meta#472, server part. Branch `fix/ttv-472-pin-yq-by-install`.

## 1. Code

- [ ] 1.1 `scripts/check.sh`: `YQ_SHA256`, `YQ_DOWNLOAD_BASE`, `yq_install`, subcommand and usage
      line `yq-install`, comment of `yq_pinned()`.
- [ ] 1.2 `main.yml` job `checks` and `dependencies.yml` job `update`: step
      `yq is the pinned version` before the first yq step; replace the "runner image" comment.
- [ ] 1.2a `main.yml` job `install`: checkout of this repository right after the token step (`token: ${{ steps.token.outputs.token }}`,
      as `workflow-tokens` requires; `persist-credentials: false`; no `repository:`), step `yq is the pinned version`, then the step that compares
      only `jq` (name and "runner image" comment adjusted); the `infra` checkout stays after them.
- [ ] 1.3 `AGENTS.md`: the workflow checks use the yq that `check.sh yq-install` installs.
- [ ] 1.4 `workflow_selftest`: proofs (a) wrong digest, (b) missing file, (c) matching file,
      (d) the existing `yq_pinned` cases stay.
- [ ] 1.5 A changeset for the server (`.changeset/`, lower-case file name).

## 2. Test plan

### 2.1 Scope and risk

Files in scope and their tests (`test/check-yq-install.test.js` covers all):

1. `scripts/check.sh` (`YQ_VERSION`, `YQ_SHA256`, `yq_install`, `yq-install`, usage line): high
   risk, because a wrong digest check installs unverified code on every runner. Every case of 2.3.
2. `.github/workflows/main.yml` jobs `checks` and `install`, `.github/workflows/dependencies.yml`
   job `update` (new step): medium risk; text checks of position, command and absence of a token
   or version. Job `install` is server only and is the riskiest of the three: it holds the App
   token for infra and had no checkout of this repository, so the step needs one, which must give
   the token to nothing and keep no credentials.
3. `AGENTS.md` and workflow comments (no "runner image" statement about yq): low risk; one text check.

Out of scope: the other repositories (their own plans); `yq_pinned()` semantics (unchanged, its
existing cases stay in `workflow-selftest`); `jq` (its comparison stays and one test shows it
stays); `workflow-tokens` and `workflow-pins` (the issue requires them to pass unchanged, which
`scripts/check.sh all` shows, in CI where `yq` is installed). The real download from GitHub
(network) is a CI check, not a unit test (AC-1, AC-4, AC-5 in 2.2). Nothing here touches torrent
startup: the tests run a shell script against fake files and read text files.

### 2.2 Types, levels and commands

1. Unit/integration (`node:test`, one file, a scratch repository with a copy of `check.sh`, a
   fake `yq_linux_amd64`, `YQ_DOWNLOAD_BASE=file://...`, `YQ_BIN_DIR`):
   `node --test test/check-yq-install.test.js`
2. Pass/fail command: `npm test` (lint, then every test); CI also runs
   `bash scripts/check.sh workflow-selftest` (needs `yq`, which the step installs).
3. Checks at the level of CI, not unit tests (they need the network or GitHub):
   1. AC-1: in the pull request's `Checks` run, `gh run view <id> -R torrent-tv/server --log | grep 'version v4.54'`
      shows `yq (https://github.com/mikefarah/yq/) version v4.54.1` from the step and the
      passing `workflow-tokens` step, on an image that ships 4.54.3.
   2. AC-4: `gh workflow run Dependencies -R torrent-tv/server --ref main`, then the log has 0 `yq is not`.
   3. AC-5: the first `Main` run after the merge: the log of job `Install <version> in infra`
      holds `yq (https://github.com/mikefarah/yq/) version v4.54.1`.
   4. AC-7: `bash scripts/check.sh all`; `check.sh copies` shows the four blocks equal.
4. AC-2 is checked twice: the node cases below and the same proofs inside `workflow-selftest`
   (task 1.4). The node cases are the ones a developer runs here (no `yq` on this Mac needed).

### 2.3 Case coverage

Positive:
1. Digest matches: exit 0, `yq` is executable, no `yq.part` left, the version line is printed (AC-1).
2. `GITHUB_PATH` set: the bin directory is appended after the existing content (AC-1).
3. `YQ_BIN_DIR` unset: installs under `$RUNNER_TEMP/yq-bin` (AC-1).
4. `check.sh` holds `YQ_VERSION=4.54.1` and the digest `8e34fc29...ea5f`; the usage line names
   `yq-install` (AC-1).
5. Workflow text: the step is in `checks` before `Workflow tools are pinned exactly`, in `update`
   before the `check.sh all` step; its command is `bash scripts/check.sh yq-install`; no token,
   secret or `env`; no workflow names a yq version (AC-1).
6. Job `install`: a checkout of this repository (no `repository:`, `token:` is the App token output `steps.token.outputs.token`,
   `persist-credentials: false`) after the token step comes before the step `yq is the pinned version`, which comes
   before the step that writes into infra; the job names no yq version, never runs
   `yq --version`, and still compares `jq-1.8.1` (AC-5).
7. No yq line says "runner image" in `main.yml`, `dependencies.yml`, `AGENTS.md`, `check.sh`;
   `AGENTS.md` names `yq-install` (AC-6).

Negative (each states the expected error):
1. Wrong digest: exit not 0, output holds `::error::yq_linux_amd64 v4.54.1 does not match the pinned SHA-256`,
   bin directory empty (no `yq`, no `yq.part`), `GITHUB_PATH` untouched (AC-2).
2. Empty download: the same as a wrong digest (AC-2).
3. Download failure (release has no `yq_linux_amd64`): exit not 0, curl's own error
   (`curl: (37)`) is shown, no mismatch message, nothing installed (AC-2).
4. Wrong version: only `v4.54.3` exists; the install requests `v4.54.1`, fails like a download
   failure and does not install the 4.54.3 file (AC-2).
5. `curl` missing: exit not 0, the output names `curl`, nothing installed (AC-2).
6. `sha256sum` missing: exit not 0, the output names `sha256sum`, nothing installed (AC-2).
7. A refused download over an existing `yq`: the earlier `yq` is untouched (AC-2).

Boundary: the empty file (the smallest download) and a bin directory that already holds a `yq`.
Not covered: a partial download that curl itself reports (curl `--fail` and exit status are
curl's), non-x64 (out of scope), `sha256sum` rejecting a digest of the wrong length (`YQ_SHA256`
is a committed constant, shown by the first positive case). The ordering of the `install` job
steps is shown by text position, because a workflow cannot run here.

### 2.4 Rules and exit

1. Each test is marked `todo` with its AC id and fails before the code exists, in the way 2.3
   states. Run with the command of 2.2.1: 21 tests; the 10 that run the subcommand fail with
   the `usage:` line of `check.sh` (the subcommand does not exist), the rest on the missing
   pin, step, usage word or the "runner image" lines.
2. Tests are deterministic: a scratch directory per case, `file://` downloads, no sleep, no
   real network, no dependence on the real `yq`.
3. Exit: `npm test`.
