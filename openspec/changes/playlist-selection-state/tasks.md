# Tasks: Playlist selection state

## 1. Implementation

- [x] 1.1 playlist.css: move the red fill off focus — `:focus-visible` renders
      an inset accent outline; red fill stays on `:hover` and
      `[aria-current="true"]`
- [x] 1.2 Verify in the browser: fresh playlist shows no current row (focused
      first row shows outline, not fill); selection survives error → Choose
      File; selection cleared after returning to the picker
      (verified in preview: fresh drawer — no aria-current, focused row
      transparent; playing row red; error-persistence and reset-clearing
      verified earlier with 0.8.27)

## 2. Release

- [x] 2.1 CHANGELOG.md entry at current package.json version + 1 patch
- [ ] 2.2 Deploy and verify via window.env.version
