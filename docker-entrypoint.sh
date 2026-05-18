#!/bin/sh
set -e

# Sync static assets from the image into the shared volume every time the
# container starts. This ensures nginx always serves the latest files after
# a Docker image update — Docker does not re-populate named volumes on its own.
if [ -d /app/public ]; then
  mkdir -p /app/public-volume
  cp -a /app/public/. /app/public-volume/
  echo "[entrypoint] Synced static files to /app/public-volume"
fi

exec "$@"
