# Tasks: OS-driven light/dark theme for the app views

## 1. Implementation

- [x] 1.1 Add `public/css/theme.css` (`:root` tokens: `color-scheme`,
      `--view-bg`, `--view-text`, `--view-text-muted`, `--view-accent`,
      `--view-track`) and link it in `index.html`
- [x] 1.2 torrent.css: background, text, muted abstract, hover accent →
      tokens
- [x] 1.3 loading.css: background, text, muted status, progress rail/value →
      tokens
- [x] 1.4 error.css: background, text, muted description, action hover →
      tokens
- [x] 1.5 Verify both schemes in the browser (emulated dark and light):
      dialog + backdrop colours, progress bar, hover states
      (verified in preview: dark — black bg, white text/accent, 75% muted;
      light — unchanged original palette)

## 2. Release

- [x] 2.1 CHANGELOG.md entry at current package.json version + 1 patch
- [ ] 2.2 Deploy and verify via window.env.version
