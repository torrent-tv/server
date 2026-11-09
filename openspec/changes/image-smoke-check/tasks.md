## 1. Test plan

Written by the test writer before any test. Covers AC-S1 to AC-S3.

## 2. Tests (failing, one commit)

- [ ] 2.1 Tests from the plan, committed failing: `test(server): …`

## 3. Implementation

- [ ] 3.1 `server.js --check` as in design Decision 1
- [ ] 3.2 `Dockerfile` final stage runs it
- [ ] 3.3 CI `build` job; release needs it
- [ ] 3.4 `CHANGELOG.md` `## Unreleased` entry
- [ ] 3.5 `npm test` exits 0

## 4. After merge (coordinator)

- [ ] 4.1 Throwaway PR with a broken Dockerfile fails `Image build` (AC-S4)
