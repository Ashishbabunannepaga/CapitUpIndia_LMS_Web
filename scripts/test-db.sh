#!/usr/bin/env bash
# Applies the Supabase migrations to a throwaway PostgreSQL database and runs
# the access-control tests in supabase/tests.
#
# Usage:
#   scripts/test-db.sh                  # starts a temporary local cluster (needs initdb/pg_ctl)
#   DATABASE_URL=postgres://... scripts/test-db.sh   # uses an existing empty database
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PSQL_OPTS=(-v ON_ERROR_STOP=1 -q -X -o /dev/null)

cleanup() { :; }
trap 'cleanup' EXIT

if [[ -z "${DATABASE_URL:-}" ]]; then
  PG_BIN="${PG_BIN:-$(dirname "$(command -v pg_ctl 2>/dev/null || ls /usr/lib/postgresql/*/bin/pg_ctl | tail -1)")}"
  TMP="$(mktemp -d)"
  PORT="${PGPORT_TEST:-54329}"
  RUN_AS=()
  if [[ "$(id -u)" == "0" ]]; then
    chown -R postgres "$TMP"
    RUN_AS=(runuser -u postgres --)
  fi
  "${RUN_AS[@]}" "$PG_BIN/initdb" -D "$TMP/data" -U postgres -A trust >/dev/null
  "${RUN_AS[@]}" "$PG_BIN/pg_ctl" -D "$TMP/data" -o "-p $PORT -k $TMP -c listen_addresses=''" -l "$TMP/log" -w start >/dev/null
  cleanup() { "${RUN_AS[@]}" "$PG_BIN/pg_ctl" -D "$TMP/data" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$TMP"; }
  DATABASE_URL="postgresql://postgres@/postgres?host=$TMP&port=$PORT"
fi

echo "Applying Supabase stub"
psql "${PSQL_OPTS[@]}" "$DATABASE_URL" -f "$ROOT/supabase/tests/supabase_stub.sql"

for f in "$ROOT"/supabase/migrations/*.sql; do
  echo "Applying $(basename "$f")"
  psql "${PSQL_OPTS[@]}" "$DATABASE_URL" -f "$f"
done

for f in "$ROOT"/supabase/tests/*.test.sql; do
  echo "Running $(basename "$f")"
  psql "${PSQL_OPTS[@]}" "$DATABASE_URL" -f "$f"
done
