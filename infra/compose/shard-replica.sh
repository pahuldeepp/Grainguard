#!/bin/sh
set -eu
: "${GG_PRIMARY_HOST:?primary host required}"
: "${GG_REPLICATION_PASSWORD:?local replication password required}"
: "${PGDATA:=/var/lib/postgresql/data}"
[ "$PGDATA" = /var/lib/postgresql/data ] || { echo "Unexpected replica data directory" >&2; exit 1; }
if [ "$(id -u)" = 0 ]; then
  mkdir -p "$PGDATA"
  chown postgres:postgres "$PGDATA"
  chmod 0700 "$PGDATA"
  exec su-exec postgres /bin/sh "$0" "$@"
fi
if [ ! -f "$PGDATA/.gg-basebackup-complete" ]; then
  # A failed backup may leave partial files. This is a replica-only volume;
  # never run this script on a primary or a shared volume.
  find "$PGDATA" -mindepth 1 -maxdepth 1 -exec rm -rf {} +
  backup_passfile="$(mktemp /tmp/gg-replication.XXXXXX)"
  chmod 0600 "$backup_passfile"
  trap 'rm -f "$backup_passfile"' EXIT HUP INT TERM
  printf '%s:5432:replication:gg_replicator:%s\n' "$GG_PRIMARY_HOST" "$(printf '%s' "$GG_REPLICATION_PASSWORD" | sed 's/\\/\\\\/g;s/:/\\:/g')" > "$backup_passfile"
  export PGPASSFILE="$backup_passfile"
  PGCONNECT_TIMEOUT=5 pg_basebackup --checkpoint=fast -h "$GG_PRIMARY_HOST" -U gg_replicator -D "$PGDATA" -Fp -Xs -R -S gg_replica
  # pg_basebackup -R can record libpq connection options. Replace its connection
  # string explicitly so the password is held only in a private .pgpass file.
  sed -i '/^primary_conninfo =/d' "$PGDATA/postgresql.auto.conf"
  printf "primary_conninfo = 'host=%s port=5432 user=gg_replicator'\n" "$GG_PRIMARY_HOST" >> "$PGDATA/postgresql.auto.conf"
  rm -f "$backup_passfile"
  trap - EXIT HUP INT TERM
  unset PGPASSFILE
fi
# Keep the replication password in a mode-0600 file, never postgresql.conf.
printf '%s:5432:replication:gg_replicator:%s\n' "$GG_PRIMARY_HOST" "$(printf '%s' "$GG_REPLICATION_PASSWORD" | sed 's/\\/\\\\/g;s/:/\\:/g')" > "$PGDATA/.pgpass"
chmod 0600 "$PGDATA/.pgpass"
[ -f "$PGDATA/standby.signal" ] || { echo "Refusing a non-standby data directory" >&2; exit 1; }
touch "$PGDATA/.gg-basebackup-complete"
export PGPASSFILE="$PGDATA/.pgpass"
exec postgres -D "$PGDATA" -c hot_standby=on -c "max_connections=${GG_PG_MAX_CONNECTIONS:-250}" -c "max_wal_senders=${GG_PG_MAX_WAL_SENDERS:-20}" -c "max_replication_slots=${GG_PG_MAX_REPLICATION_SLOTS:-20}"
