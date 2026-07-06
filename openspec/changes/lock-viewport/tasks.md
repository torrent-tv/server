# Tasks: Lock the document viewport

## 1. Implementation

- [x] 1.1 layout.css: `overflow: clip` on `html` and `body`; `html`
      block-size 100%, `body` block-size 100dvh (drop min-block-size)
- [x] 1.2 theme.css: dark `--view-text` → `#e6e6e6` (accent stays `#fff`);
      update the dark scenario in the pending `view-color-scheme` spec delta
- [x] 1.3 Verify in the browser: no document scroll with the player visible
      and the drawer closed/open; playlist still scrolls internally
      (verified in preview: scrollTo attempts stay at 0,0 with the
      wider-than-viewport player shown; playlist scrollTop works; dark title
      renders #e6e6e6)
- [ ] 1.4 Field-verify rotation on a real phone after deploy

## 2. Release

- [x] 2.1 CHANGELOG.md entry at current package.json version + 1 patch
- [ ] 2.2 Deploy and verify via window.env.version
