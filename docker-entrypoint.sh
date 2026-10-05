#!/bin/sh
set -e

# Sync static files from image into the shared volume.
# nginx serves them directly; a clean copy on every start
# ensures files removed from the image also disappear from the volume. `*`
# does not match names starting with a dot, so the volume is emptied with find.
find /app/public-volume -mindepth 1 -maxdepth 1 -exec rm -rf {} +
cp -rp /app/public/. /app/public-volume/

exec "$@"
