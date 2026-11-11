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
- The tag (`changeset git-tag`, pushed with the release App token) and the GitHub
  Release come after the image: a tag means the image exists. `latest` is a copy of the newest
  version of the run's list (`docker buildx imagetools create`, no rebuild). A re-run of the failed
  `publish` of an older run, after a newer run released, sets `latest` back to the older version;
  nothing reads `latest` in production (infra pins version and digest, and only
  `docker-compose.local.yml` names it), and the next release moves it forward again.
- The checkout, the tag push and the Release use the release App token with `contents: write`
  and `workflows: write`. A version commit may change workflow files, GitHub refuses a tag that
  reaches one from an App without `workflows` permission, and `GITHUB_TOKEN` can never have it
  (measured 2026-11-10: infra `v0.0.10` was refused, message in torrent-tv/meta#336). No
  workflow listens to tags, so the push starts no run. The job's own `GITHUB_TOKEN` keeps
  `contents: read` and `packages: write` for the registry login.
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

### Copy and format checks of the changesets (2026-11-10, found by the acceptance check)

- Measured defect: `proxy` released the note of one changeset in two versions (2.107.82 and
  2.107.83). A branch cut from the old tip of `main` in the 22 s between a merge and the force-push
  of `version` kept the old commit; a plain `git rebase origin/main` kept it too, because its patch no
  longer equals the rewritten commit (the version files differ), and it added the changeset again. The
  step "Pull request carries no copy of a commit on main" compared only `origin/main..HEAD` with
  `HEAD..origin/main`, which is empty once the branch sits on top of `main`.
- A check of the path (`git log origin/main --diff-filter=A -- <changeset>`) does not see it either:
  the rewritten commit never holds the changeset, so `main` has never added that path (measured on
  `.changeset/docs-ttv-336-link-shared-rules.md`). The step compares each commit of the pull request
  with the whole history of `main` by author e-mail, author time and subject, which a rewrite and a
  rebase keep. `bash scripts/check.sh copies <base> <head>`.
- Measured defect: a changeset in the old `- **Fix**: ...` format was released as
  `- - **Fix**: ...` (proxy 2.107.85). The step "Changesets of the pull request are one plain
  sentence" (`bash scripts/check.sh changeset-format <base> <head>`) refuses a changeset whose text
  starts like a list, heading, bold label, quote or code, has more than one paragraph, has no text, or
  has text and no package. An empty changeset (`changeset add --empty`) is allowed only where
  `CHANGESET_EMPTY_ALLOWED=yes` (ha-addon). The rule is in `torrent-tv/workflows` CONTRIBUTING.md,
  "Versions and releases", item 1.
- Proof on bad input: `bash scripts/check.sh changesets-selftest` (the step "Changeset checks fail on
  bad input") builds the exact copy case in a scratch repository, shows that the earlier range
  comparison passes it and that `copies` fails it, and runs each format rule on a bad and a good file.
  The step runs before the two checks it proves, so a refusal never hides it. The self-test clears every
  variable of `git rev-parse --local-env-vars`, and a case shows that a repository named by
  `GIT_OBJECT_DIRECTORY` and `GIT_COMMON_DIR` stays unchanged.
- Known limits of the format check (reviewed 2026-11-10, not the measured defect): two sentences in one
  paragraph pass, because the number of sentences is not decidable from the text; `__name` and a wrapped
  line starting with `- ` are refused. Of the copy check: a copy whose author date was reset
  (`rebase --ignore-date`, `commit --amend --reset-author`) or whose subject was reworded is not seen.

### The message of a prepared commit is tested before the push (2026-11-11, torrent-tv/meta#425)

- Measured defect: the dependency job prepared a commit whose body had a line of 120 characters (proxy
  pull request 63, review finding 2). The tests passed and the job pushed it; the commitlint step of
  `Checks` refused it on `main` afterwards, because `body-max-line-length` is 100. Nothing tested the
  message before the push, and a pushed commit cannot be taken back.
- The step "Test every commit, oldest first" now writes the message of each prepared commit to a file and
  runs the repository's `.githooks/commit-msg` on it, which refuses what the commitlint step would refuse
  (header, subject, line length), before the installation and `scripts/check.sh all`. A refused message is
  handled like a failed check: that commit and the ones after it are not pushed, `commit message rejected
  on <header>` goes into the failed list, the header is escaped as a workflow-command value in the error
  line, and the run ends red.

### Checks of the workflow files (2026-11-11, torrent-tv/meta#423, #424, #425)

Each check is a leg of `scripts/check.sh`, a step of `Checks` and a part of `all`; `workflow-selftest`
(the step "Workflow checks fail on bad input") builds the bad inputs and fails when a check stops
seeing one. They need yq 4.54.1, the version of the runner image that server's `install` job checks.

- `workflow-pins` (Security rule 6): refuses a `uses:` that is not `owner/repo@vX.Y.Z`, `@<40 hex>`,
  `docker://image:X.Y.Z`, a digest or `./path`; any `node-version:` (only `node-version-file:`); a
  `docker/setup-buildx-action` step without `driver-opts: image=moby/buildkit:vX.Y.Z` or `driver: docker`;
  an `npm install`, `npx` or `npm exec` that names a package other than `name@X.Y.Z` (for `npx -p <spec>`
  and `npx --package=<spec>` the spec is checked and the command after it is not; a version in a
  variable passes where the same script tests it against `^[0-9]+\.[0-9]+\.[0-9]+$`; `npx --no-install`
  installs nothing); a `docker pull` or `docker run` of an image without `:X.Y.Z` or a digest. Base
  images in Dockerfiles are not read.
- `workflow-tokens`: in `dependencies.yml` the job `update`, which runs the install scripts and tests of
  packages it has just resolved, has no token in its `env`, in a `with`, or kept by a checkout; the steps
  that hold one are exactly `DEPENDENCY_TOKEN_STEPS` (they read public data). Every job that pushes
  is a row of `WORKFLOW_PUSHES`; a job pushes when a `run:` has `git push` (also `git -C <dir> push`),
  `gh release create` or `changeset git-tag`, or a `gh api` write (`-X POST|PATCH|PUT|DELETE`, or `-f`
  fields) to a git, contents, merges, releases or branches endpoint, or calls a script (`node`, `bash` or
  `sh <path>`) whose text pushes (`git push`, `git("push"`, `["git", ..., "push"]`; one level, and not
  `scripts/check.sh`, which holds the patterns as data), so infra's `deploy`, which pushes in
  `scripts/deploy.mjs`, needs its row. An App token for a row has exactly the listed `permission-*` inputs, its checkout
  uses that token, every `gh` step reads it, and nothing names the plain `GITHUB_TOKEN`. A push of a
  commit that changes a workflow file needs `permission-workflows: write`, which `GITHUB_TOKEN` never has
  (run 42919325834: the tag push of `publish` was refused until the token had it). The one row with the
  token `github` lists the job's own `permissions`.
- `commit-msg-bot`: takes the step "Test every commit, oldest first" and the helper `commit` from
  `dependencies.yml`, runs them in a scratch repository with a stub `npm` and a stub `scripts/check.sh`,
  and requires that a commit with a body line of 120 characters is refused and the commit before it kept,
  and that a commit made by the helper (folded body) passes.
- Proof on bad input: `workflow-selftest` runs `workflow-pins` on each refused form and on the forms that
  pass (each of the 8 places where `workflow-pins` refuses was switched off by itself in a copy of
  `check.sh`, and the self-test then failed on a case written for it; the two `npx` package options,
  `-p` and `--package=`, each have a refused and a passing case), `workflow-tokens` on copies of this repository's workflow files with one change each (the token
  back in the job env, on the testing step, without `workflows`, with an extra permission, a checkout
  without the App token, the plain token in the env of the workflow, in the env of a pushing job and in
  its script, `gh` without an App token, a pushing job missing from the table, a table row without a job,
  each row deleted in turn, an unlisted job that pushes by `git -C`, by `gh api` (method on the next line
  too) or through a node or shell script, in a `.yaml` file, and a `github` row whose permissions differ
  from the job's, a secret in the env of `dependencies.yml`, a step listed as holding a token that holds
  none, a row whose job has no App token step with its id, a plain token in the env of a step that does
  not run `gh`, `git push` in a quoted or a template string of a called script, no `dependencies.yml` and
  no job `update`), and `commit-msg-bot` on a copy of the loop whose hook call is replaced by `true`. Each
  of the 17 places where `workflow-tokens` refuses was switched off by itself in a copy of `check.sh`,
  and the self-test then failed on a case written for it; where two rules would refuse the same input, the
  case uses input that only one of them refuses (a secret instead of the GITHUB_TOKEN, a table without the
  rows of the missing file).
- Limits, read from the code and not covered: `workflow-pins` does not read `container:` or
  `services.*.image`, `runs-on: *-latest`, `pip install`, `curl ... | sh`, `yarn dlx`, `sh -c "npx ..."`,
  or the base images of Dockerfiles (open in torrent-tv/meta#423); a `docker run` option with a value
  that is not in its list is read as the image (it fails safe); the proof of a version in a variable is
  textual (the test is in the same script, not on the path to the install); when the runner image changes
  yq, `Checks` and the dependency job fail until `YQ_VERSION` is changed in a commit. `workflow-tokens`
  does not see a push by a script run directly (`./scripts/x.sh`), by `node` with flags before the path,
  by `cd ... && node ...`, by `npm run`, by a module that the called script imports or a script that a
  script calls, by a wrapper such as `run("push")`, by `curl` to the API, by `gh pr merge` or by a `uses:`
  action. `echo "... git push ..."` counts as a push and so fails safe.

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
