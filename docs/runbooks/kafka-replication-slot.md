# Runbook: PostgreSQL replication slot inactive or retaining too much WAL

**Owner:** platform on-call (data).  
**Severity:** ticket for `ReplicationSlotInactive`, `ReplicationSlotWALRetainedWarning`, `ReplicationSlotWALCapUnbounded`; page for `ReplicationSlotInactiveCritical`, `ReplicationSlotWALRetainedCritical`, `ReplicationSlotWALStatusDegraded`.  
**Signals:** `pg_wal_slot_active`, `pg_wal_slot_retained_bytes`, `pg_wal_slot_cap_bytes`, `pg_wal_slot_status_degraded` from the `postgres-exporter-slots` instance (compose profile `brokers`); same measurement as `make wal-check`. Thresholds follow [WAL retention](../WAL_RETENTION.md): warn at 50 percent of `max_slot_wal_keep_size` (2 GB locally), page at 75 percent, page immediately for an unreserved or lost slot.

The cap is enforced at checkpoints and is not a disk quota; retained bytes are per slot and overlap, so the sum overstates real WAL disk use.

## Symptom

A logical replication slot is inactive, retaining a rising share of the configured WAL cap, unbounded, or marked unreserved/lost. Identify the slot and owning connector before recovery.

## Diagnosis

1. `make wal-check` prints cap, warning threshold, active state, WAL status and retained bytes per slot and exits non-zero for lost or unreserved slots.
2. Which slot? The `slot_name` label names it; connector names map to slots in `infra/kafka/connectors/*.json`. An inactive slot means no walsender: check the connector ([kafka-connect-failed](kafka-connect-failed.md)). A slot that belongs to no running connector is orphaned and keeps retaining WAL.
3. Rate: compare `pg_wal_slot_retained_bytes` over the last hour to the time left to the cap. Also check free disk on the database volume.
4. Manual query (read only): `docker compose --env-file .env -f infra/compose/compose.yaml exec -T postgres psql -X -U postgres -d postgres -c "SELECT slot_name, active, wal_status, pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn) AS retained FROM pg_replication_slots"`.

## Mitigation

- Get the consumer attached again first (restart the connector). Retained bytes fall once Debezium confirms flush.
- If a healthy consumer is attached but bytes keep growing, the connector is stalled or downstream Kafka is blocked: see [Kafka consumer lag](kafka-consumer-lag.md).
- Retained above 75 percent and not falling: reduce or stop admission that produces outbox writes only under the approved recovery procedure, and get disk headroom before the cap. Raising `POSTGRES_MAX_SLOT_WAL_KEEP_SIZE` needs a PostgreSQL recreate and disk checks.
- Slot `unreserved` or `lost`: required WAL is gone; restarting cannot recover it. Follow [WAL retention and CDC recovery](../WAL_RETENTION.md): re-snapshot with a fresh slot and connector, replay retained outbox rows with original IDs, reconcile before restoring admission.
- Do not drop an orphaned slot until you have positively identified it (name, database, no owning connector) and recorded that in the incident.
- Unbounded cap (`pg_wal_slot_cap_bytes` is -1): set a positive `max_slot_wal_keep_size`.

## Verify

`make wal-check` exits 0, retained ratio is falling, `pg_wal_slot_active` is 1 for every expected slot, alerts resolve.

## Escalation

Page the data owner when retained WAL passes 75 percent without a falling trend, when disk free drops below 15 percent, or when any slot is unreserved or lost.
