#!/bin/sh
set -eu

if [ -z "${DATABASE_URL:-}" ]; then
  echo "DATABASE_URL is required" >&2
  exit 1
fi
if [ "${RESTORE_CONFIRM:-}" != "RESTORE_8CARDS_DATABASE" ]; then
  echo "Set RESTORE_CONFIRM=RESTORE_8CARDS_DATABASE after verifying the target database." >&2
  exit 1
fi
if [ "$#" -ne 1 ] || [ ! -f "$1" ]; then
  echo "Usage: restore-postgres.sh /path/to/backup.dump" >&2
  exit 1
fi

pg_restore --dbname="$DATABASE_URL" --clean --if-exists --no-owner --no-privileges --single-transaction "$1"
echo "Restore completed"
