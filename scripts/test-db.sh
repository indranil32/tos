#!/usr/bin/env bash
# Throwaway PostgreSQL for local tests when Docker is not available.
# Usage: scripts/test-db.sh start|stop
# Prints OWNER_URL=... and APP_URL=... on start.
set -euo pipefail

PORT="${TEST_PG_PORT:-54329}"
DATA="${TEST_PG_DATA:-/tmp/tos-test-pg}"
BIN="$(pg_config --bindir 2>/dev/null || true)"
if [ ! -x "$BIN/initdb" ]; then BIN="$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1)"; fi
[ -x "$BIN/initdb" ] || { echo "PostgreSQL server binaries not found" >&2; exit 1; }

as_pg() {
  if [ "$(id -u)" = "0" ]; then runuser -u postgres -- "$@"; else "$@"; fi
}

case "${1:-}" in
  start)
    if ! as_pg "$BIN/pg_ctl" -D "$DATA" status >/dev/null 2>&1; then
      rm -rf "$DATA"; mkdir -p "$DATA"
      [ "$(id -u)" = "0" ] && chown postgres "$DATA"
      as_pg "$BIN/initdb" -D "$DATA" -U postgres -A trust >/dev/null
      as_pg "$BIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp -c listen_addresses=127.0.0.1" -l "$DATA/server.log" -w start >/dev/null
    fi
    PSQL=(as_pg "$BIN/psql" -h /tmp -p "$PORT" -U postgres -v ON_ERROR_STOP=1 -q)
    "${PSQL[@]}" -d postgres <<'SQL'
DROP DATABASE IF EXISTS tos_test;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tos_owner') THEN CREATE ROLE tos_owner LOGIN PASSWORD 'owner'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tos_app') THEN CREATE ROLE tos_app LOGIN PASSWORD 'app'; END IF;
END $$;
CREATE DATABASE tos_test OWNER tos_owner;
SQL
    echo "OWNER_URL=postgres://tos_owner:owner@127.0.0.1:$PORT/tos_test"
    echo "APP_URL=postgres://tos_app:app@127.0.0.1:$PORT/tos_test"
    ;;
  stop)
    as_pg "$BIN/pg_ctl" -D "$DATA" -m fast stop >/dev/null 2>&1 || true
    ;;
  *) echo "usage: $0 start|stop" >&2; exit 2 ;;
esac
