# view-theming — delta spec

## ADDED Requirements

### Requirement: Views follow the OS colour scheme
The torrent picker, loading and error views SHALL follow the OS/browser
colour scheme (`prefers-color-scheme`) via a shared token set declared on
`:root` with `color-scheme: light dark`, so UA-rendered surfaces (dialogs,
form controls, scrollbars) adapt together with the app styles.

#### Scenario: Dark scheme
- **WHEN** the OS/browser colour scheme is dark
- **THEN** every view renders a black background with white text, and accent
  elements (progress value, hover highlights) render white

#### Scenario: Light scheme
- **WHEN** the OS/browser colour scheme is light
- **THEN** the views keep the current light palette — white background, black
  text, red (`#c00`) accent

### Requirement: Single token source
View colours SHALL come only from the shared tokens (background, text, muted
text, accent, progress rail); view stylesheets SHALL NOT hard-code scheme
colour literals. The player keeps its own scheme-aware token set.

#### Scenario: Changing the dark accent
- **WHEN** the dark accent token value is changed in the theme file
- **THEN** all views pick up the new accent with no per-view edits
