#!/bin/sh
set -e

# Sync static files from image into the shared volume.
# nginx serves them directly; a clean copy on every start
# ensures files removed from the image also disappear from the volume.
rm -rf /app/public-volume/*
cp -rp /app/public/. /app/public-volume/

exec "$@"
