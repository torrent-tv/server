# Design: Release the server with changesets

Facts were read from the files and runs named, or measured; each says which. Analysis is
marked. The steps `version`, `plan`, `checks`, `rebase-prs` and `dependencies.yml` are
copies of infra's (torrent-tv/infra `main`, `openspec/changes/release-with-changesets/design.md`
describes their rules); only what differs for the server is written out here.

## Facts

1. State of server `main` at 1b0ea24 (`git`, 2026-11-10): the newest tag is `v0.66.53`, on
   1b0ea24 itself. `v0.66.48` to `v0.66.53` are on 18f5dbb, 8da0b41, 7acff6d, 9a852de, 070901f
   and 1b0ea24. `package.json` and the lock held `0.0.0-development`. `CHANGELOG.md` began with
   a notice that it was frozen at 0.66.47. `.changeset/` held six files in our own format, each
   consumed by one release: `ci-ttv-336-release-from-tags` by 0.66.48 (added by f8a4f07),
   `ci-ttv-374-secret-scan` by 0.66.49 (8da0b41), `ci-ttv-385-standard-checks` by 0.66.50
   (532706e), `deps-42802044571-1` by 0.66.51 (9a852de), `ci-ttv-383-workflows-repository` by
   0.66.52 (070901f) and `chore-ttv-399-drop-detect-secrets` by 0.66.53 (1b0ea24).
   `git ls-tree v<version>` lists each file in the tag it was consumed by, and the body of each
   GitHub Release equals the file's text. (The plan counted 17 files for proxy and server
   together; the server had six.)
2. `@changesets/cli` 3.0.3, run in this tree with one probe changeset: `changeset version`
   moved `0.66.53` to `0.66.54`, wrote `## 0.66.54`, `### Patch Changes`, `- Probe entry.` under
   the title line `# @torrent-tv/server`, deleted the changeset, and changed only `package.json`,
   `CHANGELOG.md` and the changeset (the lock keeps the old version until
   `npm install --package-lock-only`). Infra's `changeset git-tag` behaviour is in infra's design.
3. The runner image `ubuntu-26.04` 20261101.186.1 provides `yq` 4.54.1 and `jq` 1.8.1 (probe runs
   42841772677 and 42841936053 on this repository, branch deleted afterwards).
4. yq 4.54.1 writing `.services["server-b"].image` into infra's `docker-compose.yml` also removed
   the blank lines of the file: the diff listed at least five hunks instead of one (run 42841772677). Replacing
   the one line as text after yq read it gave `docker-compose.yml | 2 +-` with the slot not named
   by `/healthz` (run 42841936053: the site said slot `b` serves, compose named `server-a`
   0.66.52 and `server-b` 0.66.53, the written slot was `server-a`; with serving slot `a` given
   it was `server-b`; with none given, the older, `server-a`). yq also prints a warning about merge
   anchors to stderr.
5. The loop of `publish` ran in a scratch repository with a bare origin and stub `docker`, `gh`
   and `npx` commands (no network, no torrent): a commit that only changes the version, and a
   commit that only moves released sections into `CHANGELOG.md`, are not versions; two version
   commits with a plain commit between give two images, two tags (pushed) and two GitHub Releases
   with the section text as body, and `latest` on the newest; a second run builds, tags and
   creates nothing and lists the newest version again. The same `version` and `publish` scripts,
   run on a clone of this change's own history, versioned its last commit as 0.66.54 and then found
   that version only (the migration commits were skipped, tag `v0.66.53` untouched).
6. Dependabot alerts are enabled on this repository (`gh api repos/torrent-tv/server/vulnerability-alerts`
   answered 204) and none is open. A probe run of `dependencies.yml`'s `update` job on a branch
   (run 42842237072, branch deleted) read 0 alerts, found `knip` 6.44.2 to 6.45.0 by
   `npm-check-updates --target minor`, committed `chore(deps)` and tested it with
   `scripts/check.sh all`; the test step failed on `test/image-build.test.js`, which reads the job
   names of `main.yml` (`build`, `release`), as it should have for the `main.yml` of that
   commit. This change updates that test. The same minor-update steps, run on a clone of this
   change's history, made `chore(deps): update dependencies #ttv-386` with the changeset
   `deps-<run>-<attempt>.md`.
7. `package-lock.json` has no entry with `hasInstallScript`, so `npm ci --ignore-scripts` installs
   what `npm ci` installed.
8. The release App has `workflows: write`; the server `production` environment holds
   `RELEASE_APP_PRIVATE_KEY` and `RELEASE_APP_CLIENT_ID`; `main` has no ruleset; only rebase
   merge is allowed (`gh api`, 2026-11-10).
9. Node 24.22.2 and npm 11.19.1 are the versions installed here and the ones pinned in infra.

## Decisions (analysis)

### The migration

The switch commit sets `package.json` to the newest tag's version, `0.66.53`, and converts the
released changesets into the lines `changeset version` writes for a released changeset, under
the section of the first tag that held each, as `- <sha7 of the commit that added it>: <text>`.
The files are deleted, so the first pending changeset is the pull request's own. The first
release after the merge is `0.66.54`.

### Which commits are versions

`publish` takes the commits since the newest tag's own commit that added a `## <version>`
heading to `CHANGELOG.md`, and keeps only those whose `package.json` version differs from their
parent's. Infra needs only the first condition, because it had no earlier tags. Here, the
migration commit adds the headings of six released versions without changing the version, and
the commit that sets `0.66.53` changes the version without a heading; neither is a version, and
without the second condition `publish` would fail on a tag that exists on another commit.

### Publication

- The image is built from the version's own commit with `docker buildx build --push`, tagged
  `ghcr.io/torrent-tv/server:<version>` and labelled with `org.opencontainers.image.revision`
  (the commit), `.version` and `.source`. `docker/build-push-action` cannot repeat for a number
  of versions that is unknown when the workflow is written, so the loop is shell.
- The registry is asked first. Only "not found" starts a build; any other answer fails the job
  with that answer, because a rebuild would give a deployed tag another digest.
- The tag (`changeset git-tag`, pushed with `GITHUB_TOKEN`, which starts no run) and the GitHub
  Release come after the image: a tag means the image exists. `latest` is a copy of the newest
  version of the run's list (`docker buildx imagetools create`, no rebuild). A re-run of the failed
  `publish` of an older run, after a newer run released, sets `latest` back to the older version;
  nothing reads `latest` in production (infra pins version and digest, and only
  `docker-compose.local.yml` names it), and the next release moves it forward again.
- BuildKit runs from `moby/buildkit:v0.34.1` (`driver-opts` of `setup-buildx-action`); its default is
  the moving tag `moby/buildkit:buildx-stable-1` (Security rule 6). The `build` job and
  `scripts/check.sh image` use the runner's own docker daemon.
- `publish` outputs `[{version, digest}]` for every version it passed, oldest first, including a
  version a previous run released, so that a re-run of all jobs still installs.

### Install

- The job `install` is a matrix over that list, one leg at a time, oldest first (`max-parallel: 1`,
  `fail-fast`), in the concurrency group `install` (queued, never cancelled). A leg is steps of
  the old `infra-install-server` action, with standard tools in place of its scripts: `jq` reads
  `/healthz` (up to four requests, since nginx takes the two slots in turn), `yq` reads the slots
  and versions of infra's `docker-compose.yml`, and `sort -V` compares versions.
- If infra names this version or a later one, the leg writes nothing and goes on to the wait.
  Otherwise the target is the slot that does not serve, or, when none is known to serve, the slot
  with the older version.
- yq only reads (Fact 4). The line it read is replaced as plain text, and `git diff --numstat`
  must show `1<TAB>1<TAB>docker-compose.yml`, which fails the job otherwise.
- The leg adds `.changeset/run-server-<version>.md` for infra's package, commits
  `chore(deploy): run server <version> #ttv-388` as the release App and pushes to infra `main`
  (three attempts, each after `fetch` and `reset --hard`). The push starts infra's `Main` run,
  which versions the commit in place and deploys it.
- The wait asks `$SITE/env.js` every 15 s for 20 minutes. No event tells this job that the droplet
  runs the image, which is why it polls; 20 minutes is the limit of the action it replaces, a chosen
  constant, and doco-cd pulled the image in 3.5 minutes once. It fails at once when infra's `Main`
  run on the commit that names `server:<version>@` ended `failure` or `cancelled`.

### Checks

- A pull request has one `checks` leg per commit that adds a changeset and one for its head; each
  runs `tools`, `npm ci --ignore-scripts`, `pins` and `test`. The head also runs the commit,
  branch, workflow, changeset and copy checks. The job `build` builds the image once, for the
  head (`test/image-build.test.js`, torrent-tv/meta#302). An earlier changeset commit of a pull
  request is therefore tested but its image is not built; the alternative, an image build in
  every leg, costs one build per commit (13 s measured in 2026-10 for the release build).
- `Dependencies are pinned exactly` runs in every leg (`scripts/check.sh pins`).
- The `Workflows are valid` step (actionlint 1.7.12) keeps its documented ignores and one more for
  the permission scope `vulnerability-alerts` (as infra).

## Blockers and unknowns

1. Not run before the merge: the `version` job on this repository's `main` (it ran in scratch
   repositories and on infra), the `publish` step against the real registry (stubs only), and the
   `install` job end to end (its write was run on infra's real file in dry mode, Fact 4).
2. The window from merge to force-push on this repository is unknown until the first release.
3. Whether the image's digest, taken from `docker buildx imagetools inspect`, equals the one
   `docker/build-push-action` reported before is not compared; infra pins whatever digest the
   registry returns for the tag.

## Five answers

1. The viewer: nothing on the page changes. A server release reaches the droplet as before, with
   each version published from its own commit.
2. Cost to build: five workflow and script files, the `package.json` and lock change, a test edit.
3. Cost to maintain: `version`, `rebase-prs` and `dependencies.yml` are copies of infra's and change
   together (AGENTS.md Process 6); the shared actions `release-plan`, `release-tag`,
   `check-changesets`, `update-dependencies` and `infra-install-server` are no longer used here.
4. Alternatives: a Version Packages pull request and a separate release commit were withdrawn by the
   owner; the shell loop replaces `docker/build-push-action` (Decisions, Publication).
5. Undo: revert the pull request; rewritten history is not restored, but tags, images and versions stay
   valid.
