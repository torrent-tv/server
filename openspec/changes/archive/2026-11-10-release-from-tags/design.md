# Design: Release the server from tags and changesets

Line numbers at server `36a900f` (0.66.40), `torrent-tv/workflows` `bc381ae`.

## Facts

1. The newest reachable tag is `v0.66.40`, on `36a900f`, which is
   `origin/main`. `release-plan` (`scripts/release-from-tags.mjs`) plans
   `last tag + bumpOf(commits since)`; any conventional non-release commit
   gives at least patch, so this pull request's `ci(release)` commit releases
   0.66.41 after the merge. The repository allows rebase merges only.
2. `release-plan` writes the version through `npm version
   --no-git-tag-version --allow-same-version --ignore-scripts`
   (`scripts/write-version.mjs`), which sets `package.json` `version` and both
   version fields of `package-lock.json`, then checks that each file states it.
   Nothing is committed.
3. The image is built from the workspace: `docker/build-push-action` with
   `context: .` (`main.yml:108`). `.dockerignore:4-5` lets `package.json` and
   `package-lock.json` through; the `Dockerfile` copies them at `:9` (for
   `npm ci --omit=dev`) and again with `COPY --chown=app:app . .` at `:23`.
   Without `context:` the action uses the Git context, which would not hold
   the version written into the workspace.
4. Every file under `.changeset/` that a pull request adds or changes must be a
   changeset: `isChangesetPath` = `^\.changeset/[a-z0-9][a-z0-9.-]*\.md$`
   (`workflows` `scripts/lib.mjs:264`), and `check-changesets.mjs` /
   `changesetNotes` (`lib.mjs:307`) refuse any other path or any text that is
   not one or two `- **New|Fix|Chore**: …` bullets. A `.changeset/README.md`
   fails this pull request's check and the first release.
5. `.githooks/pre-push:43-52` is the only reader of `CHANGELOG.md` in the
   repository: it refuses a releasable push to `main` without an
   `## Unreleased` entry. No script, test or page reads `CHANGELOG.md`.
   `openspec/config.yaml:14-16` and `AGENTS.md:132-156` describe the old flow.
6. `CHANGELOG.md` has no `## Unreleased` section (it starts with
   `## 0.66.40`), and the server has no open pull request.

## Version at runtime

`server.js:50` reads `version` from `package.json`. It is used in four places:

- `GET /env.js` (`routes/env/get.js:14-20`, wired at `server.js:249`) renders
  `window.env = Object.assign({}, window.env, { version: "<version>" });`. The
  page's client log sends it (`public/shared/client-logger.js:422`), and
  `infra-install-server` (`workflows` `actions/infra-install-server/action.yml:91-92`)
  reads it with `sed` and compares it with `version-at-least.mjs` (`>=`).
- `/health` and `/healthz` answer `version` (`server.js:243-245`,
  `routes/health/get.js:26,33`, `routes/healthz/get.js:18,25`), display only.
- The slot handover: `createInstanceRole({ version })` (`server.js:92-94`) →
  `decideOnPeer` (`services/instance-role.js:73-94`) → `compareVersions`
  (`:49-59`). It splits on `.` and reads each part with `parseInt(…) || 0`, so
  `0.0.0-development` reads as `0.0.0`. Results (run on the placeholder):
  `compareVersions("0.0.0-development", "0.66.41") = -66`, equal to itself and
  to `0.0.0`; `decideOnPeer` gives `standby` for a placeholder instance whose
  peer serves `0.66.41`, `take-over` for `0.66.41` against a serving
  placeholder, and `take-over` between two placeholders (equal versions).
- `docker-entrypoint.sh:22` names the static release directory
  `<version>-<slot>-<start time>`; `slotOfRelease`
  (`services/static-release.js:11-13`, `/^.+-([^-]+)-\d+$/`) takes the slot
  from the end, so a version holding `-` still parses.

Consequences:

- **Production is unaffected.** Every image the release builds carries the
  released version (Facts 2-3), so `env.js`, `/healthz`, the handover and the
  entrypoint see what they see today. Infra pins images by version and digest,
  so no image built from a placeholder reaches the droplet.
- **Source checkouts and tests.** `npm start` / `npm run dev` report
  `0.0.0-development`, which is accurate. Two local slots of the same checkout
  are equal and hand over by slot order, as today with equal versions
  (`test/server-handover.test.js:33-37` runs two slots of one checkout). A
  placeholder instance never takes over a serving released one: that is the
  "never replace a newer one" rule, and it can only happen on a workstation
  peered with a released image. `npm run docker:build` tags a local image
  `:0.0.0-development` and `:latest`; it is never pushed.
- Tests: none asserts the server's own version. `test/instance-role.test.js`
  and `test/health-disk.test.js` pass literal versions. With `package.json`
  and the lock set to `0.0.0-development`, `npm test` passes (762 tests, 0
  failures, including `server-handover.test.js`).
- **The one way the placeholder could reach production** is an image built
  without the written version (a Git build context, or the build moved before
  `release-plan`). That image would start in the idle slot, find the other
  slot serving a higher version and stand by: no outage, but
  `infra-install-server` times out after 20 minutes because `env.js` never
  reports the version, and the tag is already pushed. The YAML comment on
  `context: .` says why it must stay.

## Decisions

1. **No README in `.changeset/`** (Fact 4). The format is explained in
   `AGENTS.md` "Changesets", and the frozen `CHANGELOG.md` line points there.
2. **No published-check before the build.** A re-run after a pushed image
   whose tag push failed plans the same version and rebuilds it from the same
   commit; infra is written only after the tag, so the overwritten
   `:<version>` and `:latest` are the same code. A later commit planning the
   same version overwrites the image with code that contains the earlier
   commit, and the tag lands on that later commit. A re-run whose commit a tag
   already holds skips the build (`already == 'true'`) and reads the digest
   from the registry (`main.yml:127-139`, unchanged).
3. **The image labels stay.** `org.opencontainers.image.revision` is
   `github.sha`, which is now also the tagged commit (before, the tag was on the
   `chore(release)` commit made on top of it).
4. **`workflow_dispatch` `bump` is the least step**, not the step: a `feat`
   still releases minor (`workflows` `scripts/release-from-tags.mjs:46-49`). Its
   description says so.
5. **`.githooks/pre-push` is removed** (Fact 5): its only rule requires an
   `## Unreleased` entry, which the frozen changelog never gets. `commit-msg`
   stays.
6. **No runtime change.** `0.0.0-development` gets no special case in
   `compareVersions`: released images never carry it, and in a checkout the
   current rule already gives a sensible result.

## Checks step

Replacing `main.yml:54-58`:

```yaml
      - name: Pull request adds a changeset
        uses: torrent-tv/workflows/actions/check-changesets@main
```

## Release job

The header comment (`main.yml:3-6`) becomes:

```yaml
# Every push to main runs the checks and then the release. The release takes the
# version from the newest v* tag and the Conventional Commits after it, builds and
# pushes the container image with that version, tags the commit and creates the
# GitHub release from the changesets, writes the image's version and digest into
# torrent-tv/infra (which deploys it on the droplet), and waits until the live site
# reports the new version. Nothing is committed to main.
```

`workflow_dispatch` input (`main.yml:15-16`):

```yaml
      bump:
        description: Least release step (a feat still releases minor)
```

The whole job (only the concurrency comment, `release-plan`, the comment on
`context: .` and `release-tag` change; the build, digest and infra steps are
as today):

```yaml
  release:
    name: Release
    needs: checks
    if: github.event_name != 'pull_request' && github.ref == 'refs/heads/main'
    runs-on: ubuntu-26.04
    environment:
      name: production
      url: ${{ env.SITE }}
    # Every release runs, one at a time, in the order the runs reach the queue. A later
    # run sees the earlier tag and releases what came after it; a run whose commit a
    # tag already holds only finishes what is missing.
    concurrency:
      group: release
      cancel-in-progress: false
      queue: max
    permissions:
      contents: write
      packages: write
    steps:
      - uses: actions/checkout@v7
        with:
          fetch-depth: 0
      - uses: actions/setup-node@v7
        with:
          node-version: 24

      # The version is the newest v* tag plus the step the commits ask for; it is
      # written into package.json and package-lock.json of this workspace only.
      - id: release
        uses: torrent-tv/workflows/actions/release-plan@main
        with:
          version-files: package.json,package-lock.json
          bump: ${{ inputs.bump || 'auto' }}

      - if: steps.release.outputs.released == 'true' && steps.release.outputs.already != 'true'
        uses: docker/setup-buildx-action@v4
      - if: steps.release.outputs.released == 'true' && steps.release.outputs.already != 'true'
        uses: docker/login-action@v4
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ github.token }}
      - name: Build and push the image
        id: build
        if: steps.release.outputs.released == 'true' && steps.release.outputs.already != 'true'
        uses: docker/build-push-action@v7
        with:
          # The workspace, which holds the version release-plan wrote; the Git context
          # would build 0.0.0-development, and that instance stands by behind the
          # serving slot (services/instance-role.js decideOnPeer).
          context: .
          push: true
          tags: |
            ${{ env.IMAGE }}:${{ steps.release.outputs.version }}
            ${{ env.IMAGE }}:latest
          labels: |
            org.opencontainers.image.source=https://github.com/${{ github.repository }}
            org.opencontainers.image.revision=${{ github.sha }}
            org.opencontainers.image.version=${{ steps.release.outputs.version }}

      - if: steps.release.outputs.released == 'true'
        uses: torrent-tv/workflows/actions/release-tag@main
        with:
          tag: ${{ steps.release.outputs.tag }}
          notes-file: ${{ steps.release.outputs.notes-file }}
          github-token: ${{ github.token }}

      - name: The published image's digest
        id: image
        if: steps.release.outputs.released == 'true'
        env:
          BUILT: ${{ steps.build.outputs.digest }}
          VERSION: ${{ steps.release.outputs.version }}
        run: |
          # A re-run of a published release built nothing; the registry knows the digest.
          digest="$BUILT"
          if [ -z "$digest" ]; then
            digest=$(docker buildx imagetools inspect "$IMAGE:$VERSION" --format '{{json .Manifest.Digest}}' | tr -d '"')
          fi
          echo "digest=$digest" >> "$GITHUB_OUTPUT"

      - name: Token for infra only
        id: infra-token
        if: steps.release.outputs.released == 'true'
        uses: actions/create-github-app-token@v3
        with:
          client-id: ${{ vars.RELEASE_APP_CLIENT_ID }}
          private-key: ${{ secrets.RELEASE_APP_PRIVATE_KEY }}
          owner: torrent-tv
          repositories: infra
          permission-contents: write
          permission-actions: read

      - if: steps.release.outputs.released == 'true'
        uses: torrent-tv/workflows/actions/infra-install-server@main
        with:
          github-token: ${{ steps.infra-token.outputs.token }}
          version: ${{ steps.release.outputs.version }}
          digest: ${{ steps.image.outputs.digest }}
          task: "#ttv-91"
          site: ${{ env.SITE }}
```

`dependencies.yml`, `update-dependencies` `with:` (`:31-34`):

```yaml
        with:
          github-token: ${{ github.token }}
          # The image is built from package-lock.json, so a lock-file update is released.
          ships-lockfile: "true"
          # Released from tags: the update is described in .changeset/, not CHANGELOG.md.
          changeset: "true"
```
