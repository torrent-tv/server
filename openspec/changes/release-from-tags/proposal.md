# Proposal: Release the server from tags and changesets

Parent: torrent-tv/meta#336, step 2 (server). Step 1 (the actions
`check-changesets`, `release-plan`, `release-tag` and the `changeset` input of
`update-dependencies`) is merged in `torrent-tv/.github` (`bc381ae`). The proxy
makes the same switch in torrent-tv/proxy#48; this change mirrors it where it
applies.

## Problem

Every server release commits `chore(release): <version>` straight to `main`
(`release-prepare` + `release-finish`, `.github/workflows/main.yml:88-125`), and
every pull request edits the one shared `## Unreleased` section of
`CHANGELOG.md` (`check-changelog`, `main.yml:54-58`). Two pull requests open at
once conflict on that section, and a release that moves it under a version
heading leaves the next pull request without an entry.

## Why

The release state is written back into `main`, and the pending notes are one
shared text. With a changeset file per pull request and the version taken from
the newest `v*` tag, a release writes nothing to `main` and two pull requests
never touch the same notes.

## What Changes

- `main.yml` checks: `check-changelog` is replaced by `check-changesets`.
- `main.yml` release: `release-plan` (writes the version into `package.json`
  and `package-lock.json` of the workspace) → the image build and push,
  unchanged, from the workspace (`context: .`) → `release-tag` (tag on the
  merged commit, GitHub release from the changesets) → the digest, the infra
  token and `infra-install-server`, unchanged. No commit, no branch push.
- `dependencies.yml`: `changeset: "true"`, so the daily update writes
  `.changeset/deps-<run>-<attempt>.md` instead of a changelog entry.
- `package.json` and `package-lock.json` (both fields) hold
  `0.0.0-development`; the image gets the real version because the release
  writes it into the workspace before the build.
- `CHANGELOG.md` is frozen: one line at the top points to
  https://github.com/torrent-tv/server/releases.
- `.githooks/pre-push`, whose only rule is the `## Unreleased` entry, is removed.
- `AGENTS.md` "Changelog" becomes "Changesets" (the file format) and "Deploy"
  describes the new order; `openspec/config.yaml` context drops the changelog
  rule.
- The pull request adds its own changeset,
  `.changeset/ci-ttv-336-release-from-tags.md`.

## Capabilities

### New Capabilities

None. Release tooling is not a capability covered by `openspec/specs/` (it
holds only `player-ui`).

### Modified Capabilities

None. Runtime behaviour does not change for a released image: `server.js:50`
reads the version from `package.json`, which in the image is the released one
(design.md "Version at runtime").

## Impact

CI files, `package.json`/`package-lock.json` version fields, `CHANGELOG.md`
head, `.githooks/pre-push`, `AGENTS.md`, `openspec/config.yaml`. No source or
test under `server.js`, `routes/`, `services/`, `store/`, `utils/`, `public/`,
`test/` changes. `Dockerfile`, `.dockerignore` and `docker-entrypoint.sh` do
not change.

## Non-goals

- Changing `infra-install-server`, the two-slot handover or infra (issue
  step 7: infra stays).
- Removing `release-prepare`, `release-finish`, `check-changelog` and their
  scripts from `torrent-tv/.github`: step 4.
- Treating `0.0.0-development` specially in `compareVersions` or anywhere else.
- Rewriting the history in `CHANGELOG.md`.
