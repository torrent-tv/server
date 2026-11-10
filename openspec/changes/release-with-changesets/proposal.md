# Proposal: Release the server with changesets, each commit versioned in place on main

Parent: torrent-tv/meta#336, stage 3 (server). The plan is the issue's revision 4
(https://github.com/torrent-tv/meta/issues/336#issuecomment-6765817451) and its
revision 5 amendment (https://github.com/torrent-tv/meta/issues/336#issuecomment-6768238527).
infra made the same switch first (torrent-tv/infra#11, merged); this change reuses its
workflow steps, `scripts/check.sh`, `.node-version`, `packageManager` and
`.changeset/config.json`. It supersedes `release-from-tags`, which is archived in the same
commit as this change.

## Problem

The server release (`release-from-tags`) plans a version from the newest `v*` tag and
writes it only into the workspace copy of `package.json`: git holds `0.0.0-development`,
a commit never carries its version, and the release notes are changesets in our own
`- **New|Fix|Chore**:` format that CI checks with a shared action (`check-changesets`).
The release, the dependency update and the install into infra are shared actions of
`torrent-tv/workflows` (`release-plan`, `release-tag`, `update-dependencies`,
`infra-install-server`) whose scripts and tests live outside this repository.

## Why

The owner decided (2026-11-10) that every repository releases from standard changesets:
the version lives in `package.json`, each commit that adds a changeset gets its own version
amended into it on `main`, and no release commit is ever added. Dependency updates come from
Dependabot alerts and run on a schedule, without a pull request. What only one repository
calls is not made a reusable action, so the server's install into infra becomes steps of
its own workflow, using `yq` and `jq`.

## What Changes

- `package.json` is `private` with no `publishConfig`, holds the released version `0.66.53`
  (the newest tag) instead of `0.0.0-development`, names Node 24.22.2 (`.node-version`) and
  `packageManager` `npm@11.19.1`, and pins all 13 dependencies (11 of them were ranges)
  to the version of their lock entry. New exact devDependencies: `@changesets/cli` 3.0.3,
  `npm-check-updates` 23.1.1, `semver` 7.8.6. `.npmrc` gains `save-exact=true`.
- `.changeset/config.json` and `.changeset/README.md` (`privatePackages: { version: true,
  tag: true }`). The six changeset files of `v0.66.48` to `v0.66.53` become entries of
  `CHANGELOG.md`, which is no longer frozen, and are deleted.
- `scripts/check.sh`: `tools`, `pins`, `test`, `image`, `all`. `main.yml` runs one function per
  step, and `dependencies.yml` runs `all` on every commit it prepares.
- `main.yml`: the new first job `version`; `plan` and a matrix of `checks`; `build`; `publish`
  (image, tag, GitHub Release, for every version); `rebase-prs`; `install` (infra).
  `.github/workflows` calls no action of `torrent-tv/workflows`.
- `dependencies.yml`: alerts and minor updates, tests on each prepared commit, push by the
  release App from a job that runs no package code.
- `test/image-build.test.js` follows the renamed job (`release` is `publish`) and reads the
  image command from `scripts/check.sh`.
- `AGENTS.md` describes the flow; `release-from-tags` is archived.

## Capabilities

### New Capabilities

- `release`: how a commit on `main` becomes a version, an image, a tag and a GitHub Release.
- `dependency-updates`: how alerts and updates reach `main` without a pull request.
- `install`: how a released image reaches infra and the droplet.

### Modified Capabilities

None. Nothing at runtime changes: `GET /env.js` already reads `package.json`.

## Impact

- The release App `torrent-tv-release` rewrites and force-pushes `main`, and pushes to
  infra. Its variable `RELEASE_APP_CLIENT_ID` and secret `RELEASE_APP_PRIVATE_KEY` are on
  the server `production` environment.
- The release App has `workflows: write`; the tokens of `version` and `rebase-prs` request it.
- infra has switched already (torrent-tv/infra#11 is merged), because the `install` job
  writes a changeset into infra's `.changeset/`.
