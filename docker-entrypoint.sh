#!/bin/sh
set -e

volume=/app/public-volume

if [ -z "$SERVER_SLOT" ]; then
  # One server: copy the page into the volume root, which nginx serves. A clean
  # copy on every start ensures files removed from the image also disappear
  # from the volume. `*` does not match names starting with a dot, so the
  # volume is emptied with find.
  find "$volume" -mindepth 1 -maxdepth 1 -exec rm -rf {} +
  cp -rp /app/public/. "$volume/"
  exec "$@"
fi

# Two slots: copy the page into a release directory of its own. nginx serves
# `current`, which this instance points at its release only when it starts to
# serve (services/static-release.js), so the page the other slot is serving is
# never touched here. The name carries the start time: two containers of one
# version, or a restart of this one, never write into a directory that may be
# served. Files of the one-server layout in the volume root are removed.
version=$(node -p "require(\"/app/package.json\").version")
release="${version}-${SERVER_SLOT}-$(date +%s)"
mkdir -p "$volume/releases/$release"
find "$volume" -mindepth 1 -maxdepth 1 ! -name releases ! -name current -exec rm -rf {} +
cp -rp /app/public/. "$volume/releases/$release/"
export STATIC_VOLUME_DIR="$volume"
export STATIC_RELEASE="$release"

exec "$@"
