# Tasks: Release the server from tags and changesets

Parent: torrent-tv/meta#336 step 2 (server). Branch
`ci/ttv-336-release-from-tags`. One commit
`ci(release): release from tags and changesets, with no release commit #ttv-336`
holds this change and the code it specifies. No failing-test commit: nothing at
runtime changes (design.md "Version at runtime"); the checks are CI runs
(section 3).

## 1. Files

- [ ] 1.1 `.github/workflows/main.yml`: replace the `check-changelog` step
      (`:54-58`) with `check-changesets`; replace `release-prepare`
      (`:88-93`) with `release-plan` and `release-finish` (`:118-125`) with
      `release-tag`; add the comment on `context: .` (`:108`); reword the
      header comment (`:3-6`) and the concurrency comment (`:72`). The
      buildx, login, build-push, digest, infra token and
      `infra-install-server` steps keep their inputs. Exact YAML: design.md
      "Checks step" and "Release job".
- [ ] 1.2 `.github/workflows/main.yml:16`: `bump` description "Least release
      step (a feat still releases minor)".
- [ ] 1.3 `.github/workflows/dependencies.yml`: add `changeset: "true"` to the
      `update-dependencies` `with:` (after `ships-lockfile`, with the comment
      from design.md).
- [ ] 1.4 `package.json:3`, `package-lock.json:3` and `:9`:
      `"version": "0.0.0-development"`. Use
      `npm version 0.0.0-development --no-git-tag-version --allow-same-version --ignore-scripts`;
      `git diff package.json package-lock.json` shows those three lines only.
- [ ] 1.5 `CHANGELOG.md`: insert at the top, above `## 0.66.47` (the newest entry when this pull request was rebased):
      "Releases after 0.66.47 are described at
      https://github.com/torrent-tv/server/releases; this file is no longer
      updated. A pull request describes its change in `.changeset/` (see
      `AGENTS.md`, Changesets)." Add no `## Unreleased`.
- [ ] 1.6 Remove `.githooks/pre-push` (its only rule is the `## Unreleased`
      entry). Keep `.githooks/commit-msg`.
- [ ] 1.7 `AGENTS.md`: replace "## Changelog" (`:132-138`) with
      "## Changesets": every pull request adds `.changeset/<branch with / as
      ->.md` holding one or two bullets `- **New**: …`, `- **Fix**: …` or
      `- **Chore**: …` written for a viewer (continuation lines indented by two
      spaces, no blank lines, lower-case file name); nothing else may live in
      `.changeset/` (no README); changesets are never edited after merge or
      deleted; the release notes are the changesets added since the last tag;
      never edit the `package.json` version (`0.0.0-development` in git). CI
      (`check-changesets`) refuses a pull request without one.
- [ ] 1.8 `AGENTS.md` "## Deploy" (`:140-156`): a push to `main` runs the
      checks; then the release (1) plans the version from the newest `v*` tag
      and the commits after it (`feat` or breaking → minor, any other
      Conventional Commit → patch, only non-conventional or `chore(release)`
      → none) and writes it into `package.json`/`package-lock.json` of the
      workspace only; (2) builds and pushes `ghcr.io/torrent-tv/server:<version>`
      and `:latest` from that workspace; (3) tags the merged commit and creates
      the GitHub release from the changesets; (4) writes the image into
      `torrent-tv/infra` and waits until `https://webauth.courses/env.js`
      reports the version, as today. Nothing is committed to `main`. A manual
      run's `patch`/`minor` is the least step and still needs a changeset
      since the last tag. Re-running is safe: a tag holding the commit skips
      the build. A source checkout reports `0.0.0-development`. Keep the
      browser-cache sentence; the dependency paragraph says the daily update
      is released as `fix(deps)` with a `.changeset/deps-*.md`. Update
      "Notable" (`:101-103`) to say the version in `env.js` is the released
      one in the image and `0.0.0-development` from source.
- [ ] 1.9 `openspec/config.yaml:14-16`: replace the CHANGELOG lines with
      "Every pull request adds a changeset `.changeset/<branch>.md` (see
      AGENTS.md). package.json holds 0.0.0-development; the release takes the
      version from tags."
- [ ] 1.10 `.changeset/ci-ttv-336-release-from-tags.md` (added last, see 3.1):
      `- **Chore**: Releases are made from tags with no release commit on
      main; release notes now live in GitHub Releases
      (https://github.com/torrent-tv/server/releases) instead of CHANGELOG.md.`
- [ ] 1.11 Local: `npm ci && npm test` passes with the placeholder version.
      The workflows are checked by CI's `Workflows are valid` step
      (actionlint).

## 2. Constraints

- No file other than changesets under `.changeset/` (design.md Fact 4).
- No change outside the files in section 1: no source, test, `Dockerfile`,
  `.dockerignore` or `docker-entrypoint.sh` change.
- `context: .` stays on `docker/build-push-action`, and `release-plan` stays
  before the build (design.md "Version at runtime", last point).
- `release-plan`, `release-tag`, `check-changesets` from `@main`; no input
  that step 1 does not define. `infra-install-server` is called exactly as
  today.
- Merge by rebase (the only method allowed); do not merge while another
  server release run is in progress.

## 3. Acceptance (issue #336 acceptance 1 and 4 for server)

- [ ] 3.1 The PR check fails without a changeset and passes with one: push
      the commit first without `.changeset/ci-ttv-336-release-from-tags.md`;
      the `Pull request adds a changeset` step fails with "this pull request
      adds no changeset" (record the run URL). Amend the commit to add it,
      force-push; the step passes and prints `changesets added:
      .changeset/ci-ttv-336-release-from-tags.md`, and `Lint and tests`
      passes with `0.0.0-development` (record the run URL).
- [ ] 3.2 Acceptance 1 after the merge: the `main.yml` push run is green;
      `git fetch --tags && git log --format='%h %s' v0.66.47..origin/main`
      shows no `chore(release)`; `git rev-parse v0.66.48^{commit}` equals
      `origin/main` at the merge; `gh release view v0.66.48 -R
      torrent-tv/server --json body -q .body` equals the changeset text;
      `docker buildx imagetools inspect ghcr.io/torrent-tv/server:0.66.48`
      exists and its `org.opencontainers.image.revision` is that commit;
      `curl -s https://webauth.courses/env.js` reports `version: "0.66.48"`
      (or later); the `infra-install-server` step ends green.
- [ ] 3.3 Acceptance 4: two pull requests, each adding its own changeset
      (the next real ones, or two trivial `docs` fixes), are open together;
      after the first merges, the second shows `mergeable: MERGEABLE`
      (`gh pr view <n> --json mergeable`) and its checks stay green without a
      changelog fix-up.
- [ ] 3.4 The next daily `Dependencies` run that finds an update pushes a
      commit adding `.changeset/deps-<run>-<attempt>.md` and no
      `CHANGELOG.md` change, and the `main.yml` run it starts releases it.
