#!/usr/bin/env bash
# The checks that need no secret: main.yml runs them one step each, so a run shows
# which one failed; dependencies.yml runs `all` on every commit it prepares.
#
#   bash scripts/check.sh tools | pins | test | image
#   bash scripts/check.sh all
set -euo pipefail
cd "$(dirname "$0")/.."

tools() {
  # Security rule 6: Node (.node-version) and npm (packageManager) are exact versions,
  # and the runner provides exactly those. npm is the one bundled with that Node.
  local node_want npm_want
  node_want="v$(tr -d '[:space:]' < .node-version)"
  npm_want=$(node -p 'require("./package.json").packageManager.replace(/^npm@/, "")')
  if [ "$(node --version)" != "$node_want" ] || [ "$(npm --version)" != "$npm_want" ]; then
    echo "::error::node $(node --version) and npm $(npm --version) run here; the repository pins node $node_want and npm $npm_want"
    return 1
  fi
  echo "node $node_want and npm $npm_want"
}

pins() {
  # Security rule 6: no range and no `latest`, in dependencies, devDependencies,
  # optionalDependencies and overrides; an `npm:` alias names an exact version.
  node -e '
    const pkg = JSON.parse(require("node:fs").readFileSync("package.json", "utf8"));
    const exact = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;
    const bad = [];
    const walk = (where, value) => {
      if (typeof value === "string") {
        const spec = value.startsWith("npm:") ? value.slice(value.lastIndexOf("@") + 1) : value;
        if (!exact.test(spec)) bad.push(where + " = " + value);
      } else if (value && typeof value === "object") {
        for (const [key, inner] of Object.entries(value)) walk(where + "." + key, inner);
      }
    };
    for (const field of ["dependencies", "devDependencies", "optionalDependencies", "overrides"]) walk(field, pkg[field]);
    if (bad.length) {
      console.error("::error::not an exact version: " + bad.join("; "));
      process.exit(1);
    }
    console.log("every dependency is pinned exactly");'
}

tests() {
  # `biome lint .` and `node --test` (package.json "test").
  npm test
}

image() {
  # The image checks itself in its last stage (`server.js --check`): a build that
  # succeeds loaded every module and registered every route.
  docker build -t torrent-tv-server .
}

case "${1:-}" in
  tools) tools ;;
  pins) pins ;;
  test) tests ;;
  image) image ;;
  all) tools && pins && tests && image ;;
  *) echo "usage: bash scripts/check.sh tools|pins|test|image|all" >&2; exit 2 ;;
esac
