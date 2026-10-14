#!/bin/sh
set -eu

if [ -z "${DATABASE_URL:-}" ]; then
  echo "DATABASE_URL is required" >&2
  exit 1
fi

backup_dir="${BACKUP_DIR:-/app/backups}"
mkdir -p "$backup_dir"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
output="$backup_dir/8cards-$timestamp.dump"

umask 077
pg_dump --dbname="$DATABASE_URL" --format=custom --no-owner --no-privileges --file="$output"
echo "$output"
