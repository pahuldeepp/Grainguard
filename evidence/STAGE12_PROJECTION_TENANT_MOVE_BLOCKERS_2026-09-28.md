# Projection tenant-move status — 2026-09-28

## Decision

Projection Builder is **not accepted for cross-shard tenant moves**. No owner
copy adapter or move receipt was added. `assertProjectionMovePreflight` is an
explicit fail-closed owner gate that throws for every valid tenant until the
protocol below is implemented and accepted. It is not evidence that the
placement orchestrator currently invokes the guard.

## State inventory reviewed

The inventory comes from the checked-in Projection Builder migrations and
consumer/replay implementation; this is a source audit, not a live database
catalog dump.

- Tenant projection state starts in `services/projection-builder/migrations/000001_projection.up.sql`:
  `consumer_inbox`, `projection_streams`, `device_views`, `reading_history`,
  `device_latest`, `stream_gaps`, `projection_notifications`, and
  `projection_checkpoints`.
- `000002_history_retention.up.sql` converts `reading_history` to daily UTC
  range partitions and permits maintenance to drop data outside the configured
  hot window. A table-level copy would need to preserve all surviving rows,
  create/verify compatible target partitions, and reconcile the cold-history
  route to Cassandra. The generic tenant copier does not prove those conditions.
- `000019_projection_watermarks.up.sql` adds forced-RLS
  `projection_watermarks` and `projection_event_completions`; these are
  transaction-bound freshness proofs and must move consistently with inbox,
  projection effects, notifications, and checkpoints.
- Projection Builder consumes shared Kafka topic partitions using the
  `projection-builder` consumer group. Database checkpoint rows are tenant
  scoped, but Kafka's committed frontier is topic-partition scoped. The current
  code has no pause/drain/frontier transfer protocol for moving one tenant's
  partition subset without loss, duplicate side effects, or advancing a shared
  consumer past work still required by the source shard.
- `projection_notifications` and the owner `outbox_events` are Debezium CDC
  publication inputs. There is no coordinated source/target connector offset,
  dedupe, or downstream application receipt for a tenant cutover.
- Replay, writer leases, and canonical promotion can update projection state
  outside the ordinary consumer path. No protocol fences these paths together
  with the tenant move.

## Required before enabling moves

1. Define a cutover barrier that stops new tenant projection writes and proves
   consumer/replay/promotion writers are drained at a durable Kafka frontier.
2. Copy every owner table and all retained `reading_history` partitions with
   exact row/frontier verification; coordinate the cold Cassandra history
   route and retention boundary.
3. Transfer or deliberately rebuild CDC output with stable event identities,
   connector frontier receipts, and downstream deduplication evidence.
4. Rebase watermark/completion identities only under a verified source and
   target snapshot; preserve gaps and inbox idempotency semantics.
5. Add durable target-copy and source-fence receipts and test crash/retry at
   each boundary using isolated PostgreSQL and Kafka, then wire the owner gate
   into placement advancement.

Until then, a tenant move must be blocked. The focused guard tests only prove
that the owner boundary refuses the operation and surfaces every known blocker;
they do not prove a database or Kafka move.
