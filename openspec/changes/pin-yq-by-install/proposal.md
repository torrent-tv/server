# Proposal: Install the pinned yq instead of reading the runner image's

Issue: torrent-tv/meta#472 (blocks proxy pull request 83, meta#470); server part. License of the tool: yq,
MIT (`gh api repos/mikefarah/yq/license`).

## Why

The workflow checks of `scripts/check.sh` read the workflow files with `yq`, and `yq_pinned()`
compares the `yq` of the GitHub runner image with `YQ_VERSION=4.54.1`. The image changed from
`ubuntu26/20261101.186` to `ubuntu26/20261111.196` and ships yq 4.54.3, so every check that calls
`yq_pinned` fails (`yq is not 4.54.1 ... v4.54.3`), and `Dependencies` runs fail since
2026-11-13. Root cause: the pin is compared with a version another party owns and updates.

## What changes

- `scripts/check.sh` gets `YQ_SHA256` (digest of `yq_linux_amd64` v4.54.1, committed), the function
  `yq_install` and the subcommand `yq-install`: download the release binary of mikefarah/yq at
  `YQ_VERSION`, verify the digest by comparing the first field of the `sha256sum`
  output with the committed one, refuse a mismatch with
  `::error::yq_linux_amd64 v4.54.1 does not match the pinned SHA-256`, install into
  `$YQ_BIN_DIR` (default `$RUNNER_TEMP/yq-bin`) and append that directory to `$GITHUB_PATH`.
  `yq_pinned()` stays and verifies the `yq` on `PATH`.
- `main.yml` job `checks` and `dependencies.yml` job `update` run the step
  `yq is the pinned version` (`bash scripts/check.sh yq-install`) before the first step that
  calls yq. The step holds no token. No workflow names the version.
- `main.yml` job `install` (server only) compared `yq --version` with `v4.54.1` in the step
  `yq and jq are the pinned versions`, before any checkout. It gets a checkout of this repository
  that uses the job's App token (`token: ${{ steps.token.outputs.token }}`, as the shared
  `workflow-tokens` check requires of every checkout in a pushing job; the token step `id: token`
  is the first step of the job, so it already runs before the checkout), with
  `persist-credentials: false` and no `repository:` override (the token is scoped to
  `repositories: infra`; this repository is public, so reading works). Then the step
  `yq is the pinned version`; the step that remains compares only `jq` with `jq-1.8.1` (jq is out
  of scope). The infra checkout (`path: infra`) stays after them.
- `AGENTS.md` and the `main.yml` comments (job `checks`, job `install`) no longer say that yq comes from the runner image.
- `workflow-selftest` gains the proofs of the digest, the missing file and the matching file.

## Out of scope

Moving to yq 4.54.3 or later; `jq`; non-x64 runners; the other three repositories (own pull
requests with the same `check.sh` block). This repository has no `install` subcommand in
`check.sh`; the usage line differs from the other repositories only there.
