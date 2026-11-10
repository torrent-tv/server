# Tasks: Release the server with changesets

Parent: torrent-tv/meta#336, stage 3 (server). Branch `ci/ttv-336-release-with-changesets`.
No new `node:test` applies: no code under test changes, only workflow YAML, `package.json`,
shell steps and `scripts/check.sh`; `test/image-build.test.js` follows the renamed job. The
checks are the Checks run of this pull request, probe runs and scratch repositories (design.md,
Facts 3-6), and the first runs on `main`. `[x]` is done and shown; `[ ]` waits for the merge.

## 1. Files

- [x] 1.1 `package.json` (`private`, `0.66.53`, `packageManager`, exact pins, three exact
      devDependencies), `package-lock.json`, `.npmrc`, `.node-version`, `.changeset/config.json`,
      `.changeset/README.md`.
- [x] 1.2 `CHANGELOG.md` holds the six released changesets as the entries `changeset version`
      writes; the six files are deleted.
- [x] 1.3 `scripts/check.sh` with `tools`, `pins`, `test`, `image`, `all`; `main.yml` calls one
      function per step.
- [x] 1.4 `main.yml`: `version`, `plan`, matrix `checks`, `build`, `publish`, `rebase-prs`,
      `install`; every action at an exact version; `test/image-build.test.js` updated.
- [x] 1.5 `dependencies.yml`: `update`, `push`, `result`.
- [x] 1.6 `AGENTS.md`, this change, `release-from-tags` archived.
- [x] 1.7 `.changeset/ci-ttv-336-release-with-changesets.md`, in the last commit.

## 2. Acceptance criteria and checks

- [x] 2.1 No shared action or secret scan remains. Check:
      `git grep -nE 'torrent-tv/workflows/actions|create-pull-request|push-to-main|set-bot-identity|gh workflow run|0\.0\.0-development' -- .github package.json`
      prints nothing, and
      `git grep -n 'HEAD:refs/heads/main' -- .github/workflows` finds three lines: the force-push of
      `version`, the push of `dependencies.yml` and the infra push of `install`.
- [x] 2.2 Every dependency is exact and the tools are exact devDependencies. Check:
      `bash scripts/check.sh pins`; `git grep -nE 'uses: [^ ]+@v[0-9]+$' -- .github` prints nothing.
      `pins` fails on `^7.8.6` and `tools` fails on a changed `.node-version` (run locally).
- [x] 2.3 `npm test` and `npx changeset status --since=origin/main` pass here.
- [ ] 2.3b The Checks run of the pull request passes, `Workflows are valid` included.
- [x] 2.4 The yq/jq steps of `install` on the real compose file (design.md Fact 4): dry run on a
      GitHub runner, branch deleted, run 42841936053.
- [x] 2.5 The dependency run's `update` job on a branch (design.md Fact 6, run 42842237072), and its
      steps on a clone of this change's history.
- [ ] 2.6 After the merge: a `force_push` on `refs/heads/main` by `torrent-tv-release[bot]` follows
      the `pr_merge`; this pull request's changeset commit is on `main` with its author, author time
      and header unchanged, `package.json` `0.66.54`, `## 0.66.54` in `CHANGELOG.md`, the changeset
      deleted, and no commit `chore(release)`. Check:
      `gh api "repos/torrent-tv/server/activity?ref=refs/heads/main"`, `git show --stat <sha>`.
- [ ] 2.7 The run of that push: `version` logs `no pending changesets`; `checks` and `build` pass;
      `publish` pushes `ghcr.io/torrent-tv/server:0.66.54` with label `org.opencontainers.image.revision`
      equal to the rewritten commit, tag `v0.66.54` is on it and its GitHub Release body equals the
      `CHANGELOG.md` section. Check: run URL, `docker buildx imagetools inspect`, `git rev-list -n 1 v0.66.54`,
      `gh release view v0.66.54 --json body`.
- [ ] 2.8 `install` logs `yq 4.54.1 / jq-1.8.1`, the serving slot and
      `pushed <sha7> to infra: run server 0.66.54 in server-<a|b>`; on infra `main` the commit
      `chore(deploy): run server 0.66.54 #ttv-388` is by `torrent-tv-release[bot]`, `git show --numstat`
      lists `1	1	docker-compose.yml` and the changeset, the written slot is the one `/healthz` did not name
      as serving, and infra's `deploy` is green; the job ends with `the site runs server 0.66.54`;
      `curl https://webauth.courses/env.js` reports `0.66.54`.
- [ ] 2.9 Re-running `install` logs `infra already runs server <v>; nothing to write` and pushes nothing.
- [ ] 2.10 Window: the time from `pr_merge` to `force_push`, with the `version` job's step times, is
      recorded on torrent-tv/meta#336.
- [ ] 2.11 The first `Dependencies` run after the merge ends in one of two ways: it logs
      `no updates` and `0 open Dependabot alerts` and pushes nothing, or it pushes its commits as
      the release App with the headers of infra's design.md, each versioned, built and installed.
      `update` has only `contents: read` and `vulnerability-alerts: read`, no environment and no
      `secrets.`; `push` has no `npm`, `npx` or test command.
- [ ] 2.12 Every commit on `main` after this change either matches a merged pull request commit or is by
      `torrent-tv-release[bot]` with a header ending in `#ttv-386` and only `package.json`,
      `package-lock.json` and `.changeset/*.md`, and every `force_push` has actor `torrent-tv-release[bot]`.
