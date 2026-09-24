# WAL retention and CDC recovery

The local PostgreSQL command keeps logical WAL, ten replication slots and ten
WAL senders, and sets `max_slot_wal_keep_size=2GB` (2,147,483,648 bytes).
Override `POSTGRES_MAX_SLOT_WAL_KEEP_SIZE` in `.env` and recreate PostgreSQL to
apply it. Staging currently defines no PostgreSQL command flags and does not
include the CDC overlay; this change does not enable CDC there.

Run `make wal-check` against the events stack. It queries slots belonging to each
of the inventory and telemetry databases, prints active state, WAL status and
bytes since restart LSN, and exits nonzero for lost/unreserved slots, unknown
retention or bytes above the warning threshold. `WAL_WARN_BYTES` overrides the
warning in integer bytes; by default it is half the **running server's** cap
(1,073,741,824 bytes for 2GB). An unlimited/nonpositive cap or a warning at/above
the cap is a configuration error. This is opt-in, outside `make verify`.

The cap applies at checkpoints, not as a hard disk quota. WAL may temporarily
exceed it; slots retain overlapping WAL, so summing per-slot bytes overstates
unique disk usage. Reserve disk for ordinary WAL, data growth, snapshots and
checkpoint overshoot. A cap protects the database but can destroy CDC continuity.
Size it from measured peak WAL bytes/second times the supported outage window,
with headroom; 2GB is a local default, not a production capacity claim.

Production starting thresholds (tune against measured rates and response times):

- Warn above 50% retained bytes; page above 75% or projected exhaustion within
  30 minutes. Page immediately for unreserved/lost slots or missing expected slots.
- Warn after a slot remains inactive for 2 minutes; page after 5 minutes. Track
  first inactive observation externally: PostgreSQL 16 does not expose that age
  in this query. Poll every 30 seconds and also monitor active-but-stalled slots.
- Warn below 25% disk free; page below 15% or predicted exhaustion within
  30 minutes. Preserve enough bytes for the measured response window.

These are proposed alert rules, not deployed monitoring. The script is a byte/status
probe only; it does not persist inactivity history or measure free disk.
R7 binding-feed age must alert independently: WAL capacity does not permit stale
binding admission. Follow the R7 runbook and alerts below.

When a slot is invalidated, restarting Connect cannot recover removed WAL. Stop
admission as required by feed freshness, preserve source outbox rows and consumer
inboxes, and inventory the missing interval before resetting anything. Debezium
must re-snapshot using a fresh slot and fresh connector offset identity, with the
same publication/table selection and routing to the canonical raw topics. Delete
only the positively identified obsolete connector/slot after recovery is planned;
never reset a healthy connector as a generic repair.

Replay retained outbox rows through the raw/transformer path with their original
`event_id`, tenant, version, timestamp and payload. Canonical consumers deduplicate
by `event_id` within tenant scope; they must reject conflicting payloads rather
than overwriting effects. Reconcile expected IDs/counts and feed checkpoints
before restoring admission. Outbox retention must cover the recovery interval;
if rows were purged, restore a suitable backup/archive and explicitly reconcile
the gap. A fresh snapshot cannot recover deleted history. Recovery and capacity
are UNVERIFIED until the coordinator exercises outage and invalidation tests.

## Raw-topic retention expiry (B1)

Raw topics retain records for 168 hours. If a transformer's committed offset falls
outside the retained log, it fails closed and exits non-zero with the topic,
partition, committed offset and recovery instruction. It never silently resets;
a group with no committed offset still starts at the beginning of the retained
log to consume a fresh snapshot. Alerting should page on this fatal exit.

Preserve the failed group's offsets and inventory the missing interval. Replay
retained append-only `outbox_events` rows for the gap by re-running a Debezium
snapshot with a fresh connector name and slot, preserving original event IDs and
routing. Canonical consumers deduplicate by `event_id` within tenant scope.
After planning the replay, deliberately reset the affected transformer offsets
to the retained log start (or use a fresh transformer group) to consume the
snapshot. Reconcile missing event IDs and feed checkpoints before restoring
admission. Do not merely restart or reset offsets to bypass the failure; expired
raw records require outbox replay. If outbox rows are unavailable, recover them
from backup/archive and reconcile the gap explicitly.

## R7 runbook and alerts

A stale or missing binding feed rejects new readings with HTTP
`503 binding_feed_stale` and `Retry-After: 5`; identical receipt replays still
succeed. This is intentional delayed-disable protection. A healthy idle source
must continue emitting checkpoints to all six canonical partitions.

Proposed alerts (deploy in the monitoring system; these are not installed rules):

- Warn when `binding_feed_age_seconds > 60`; page above 240 seconds (4 minutes),
  before the default 5-minute admission bound. Missing evidence is `+Inf` and
  pages immediately. Adjust thresholds when overriding the bound.
- Investigate any `rate(binding_consumer_quarantine_total{reason="heartbeat"}[5m]) > 0`.
  This counts quarantined checkpoints, including database rejections; inspect the
  quarantine envelope's reason (`heartbeat` for malformed control data,
  `db_rejected` for SQLSTATE class 22/23).
- Alert on `increase(binding_feed_clock_skew_total[5m]) > 0` and repair clock
  synchronization. Structurally valid future checkpoints are accepted with
  `source_time = min(source_time, ingest_now)`, counted per processing attempt,
  and never quarantined just for skew. Replay fences remain in force.

Triage connector downtime, source/ingest clock skew, heartbeat quarantine, raw
topic recreation, and a permanent database-error crash loop on older binaries.
Class 22/23 errors now quarantine before committing; transient database failures
still retry within the configured budget and stop without commit on exhaustion.
Other fatal database errors still need operator repair. Never reset offsets
merely to escape a crash loop.

Example local operator commands (adjust service ports for the deployment):

```sh
curl -fsS http://127.0.0.1:58083/connectors/inventory-outbox/status
curl -fsS http://127.0.0.1:8080/metrics
make wal-check
docker compose --env-file .env -f infra/compose/compose.yaml -f infra/kafka/compose.yaml logs --tail=100 connect
docker compose --env-file .env -f infra/compose/compose.yaml -f infra/kafka/compose.yaml exec -T postgres psql -X -U postgres -d greenguard_telemetry -c 'SELECT partition_id, source_time, raw_position, consumed_offset, partition_count FROM binding_feed_checkpoints ORDER BY partition_id'
docker compose --env-file .env -f infra/compose/compose.yaml -f infra/kafka/compose.yaml exec -T kafka /opt/kafka/bin/kafka-consumer-groups.sh --bootstrap-server kafka:29092 --describe --group telemetry-binding-consumer
```

Inspect consumer/transformer supervisor logs for the failed topic, partition and
committed offset. Inspect quarantine through restricted operational tooling,
including headers, without copying tenant payloads to ordinary logs. Restore
Connect, database access or clock synchronization, then confirm fresh checkpoints
for every partition and successful new admission.

For a recreated raw topic, lower raw offsets cannot pass the existing fence.
Stop admission **and the binding consumer**, preserve offsets/checkpoints for
diagnosis, and plan/reconcile replay of retained inventory outbox events with
original IDs before resetting. Do not clear inboxes or receipts. Once replay and
the transformer/consumer offset recovery plan are ready, run:

```sh
make binding-feed-reset ARGS=--yes
# Equivalent:
node scripts/binding-feed-reset.mjs --yes
```

The command rejects missing/extra arguments and clears only
`greenguard_telemetry.public.binding_feed_checkpoints` in a locked transaction.
It does not reset Kafka offsets, restart services or change admission settings.
A canonical topic recreation also needs deliberate recovery of the affected
consumer group offsets. Resume consumption/replay while admission stays stopped,
reconcile event IDs and require fresh checkpoints from all six partitions before
restoring traffic. Empty checkpoints fail closed; clearing them is not proof of
recovery.

`wal-check` reads expected slot names from `infra/kafka/connectors/*.json` and
fails for a missing expected slot in either database. Only
`WAL_ALLOW_EMPTY_STACK=1` permits a database with no slots during explicit empty
stack setup; it never excuses an unexpected slot or unhealthy existing slot.
