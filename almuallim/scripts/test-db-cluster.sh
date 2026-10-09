#!/usr/bin/env bash
# Starts/stops a disposable local PostgreSQL 16 cluster (with pgvector) for `npm run test:db`.
# Requires: postgresql-16 and postgresql-16-pgvector packages.  Usage: test-db-cluster.sh start|stop
set -euo pipefail
PGBIN=${PGBIN:-/usr/lib/postgresql/16/bin}
PGDATA=${PGDATA:-/tmp/almuallim-pg}
PGPORT=${PGPORT:-54329}
run() { if [ "$(id -u)" = 0 ]; then su postgres -c "$*"; else bash -c "$*"; fi; }
case "${1:-}" in
  start)
    if [ ! -d "$PGDATA" ]; then
      if [ "$(id -u)" = 0 ]; then mkdir -p "$PGDATA" && chown postgres "$PGDATA"; fi
      run "$PGBIN/initdb -D $PGDATA -A trust -E UTF8 --locale=C.UTF-8 >/dev/null"
    fi
    run "$PGBIN/pg_ctl -D $PGDATA -o '-p $PGPORT -k /tmp' -l $PGDATA/log -w start" >/dev/null || true
    echo "postgres://postgres@localhost:$PGPORT/postgres"
    ;;
  stop) run "$PGBIN/pg_ctl -D $PGDATA -m fast stop" >/dev/null || true ;;
  *) echo "usage: $0 start|stop" >&2; exit 2 ;;
esac
