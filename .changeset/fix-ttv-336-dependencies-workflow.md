---
"@torrent-tv/server": patch
---

- **Chore**: The daily dependencies workflow wraps the body of the commits it prepares to 100 characters, so the Checks no longer fail on a long update list, and gives the token that reads Dependabot alerts only to the steps that call `gh`, not to the install scripts and tests of newly resolved packages.
