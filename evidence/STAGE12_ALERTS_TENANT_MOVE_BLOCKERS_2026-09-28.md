# Alerts tenant move preflight — 2026-09-28

## Status

**Owner-local move is blocked; no Alerts copy/activation protocol is claimed.** The
Alerts owner preflight rejects schema drift and any tenant with CDC outbox history.
This is an intentional fail-closed boundary, not a completed migration.

## Reviewed owner tables

The exact current tenant-table inventory from the `workflow-alerts` migrations is:

1. `alert_episodes`
2. `alert_rules`
3. `alert_transitions`
4. `command_receipts`
5. `consumer_inbox`
6. `outbox_events`
7. `risk_stream_positions`

`assertAlertsMovePreflight` compares this inventory to PostgreSQL catalog state and
refuses missing/extra relations or partitioned tables. The runtime does not expose
prepare, fence, copy, activate, or abort methods because the required effect protocol
is not yet safe within the Alerts owner boundary.

## Concrete blockers

- `outbox_events` is part of PostgreSQL publication `greenguard_alerts_outbox`.
  Logical CDC has no per-row acknowledgement in this schema proving every consumer
  has applied historical events. Copying or replaying rows can emit duplicate alert
  lifecycle events; deleting/copying without topic-offset coordination can lose them.
  The preflight therefore refuses any tenant with outbox history.
- Risk events are consumed through Kafka and recorded in `consumer_inbox`. The
  repository has no owner-specific protocol to pause/drain the tenant's input stream
  through a known offset, transfer offset ownership, and resume on the target shard.
- Jobs Worker and Notifications consume alert lifecycle effects and keep their own
  tenant state/receipts. Those owners do not yet have coordinated prepare/fence/copy/
  activation receipts tied to the same operation and epoch. An Alerts-only copy could
  cause duplicate provider sends or make alert side effects diverge after cutover.
- The global Tenant Control Plane still needs to quiesce new requests and drain
  request/read leases across all owners before committing one placement epoch. This
  preflight is not an orchestrator and cannot establish that global barrier.

## Validation

The Alerts preflight unit tests cover the exact schema check, partition refusal,
historical CDC refusal, and malformed tenant rejection. These are database-query
contract tests only; no live PostgreSQL move is accepted or attempted. No shared
database, AWS account, or provider endpoint was used.

## Acceptance needed before implementing the mover

1. Define a global move operation/epoch and drain the Alert input consumer through a
   recorded Kafka offset.
2. Implement Jobs and Notifications owner receipts and provider-effect idempotency
   under that same operation.
3. Coordinate the Alerts outbox with CDC publication/consumer offsets, with a
   replay/deduplication design that survives process restart and abort.
4. Add owner-local SQL receipts, copy verification, target cleanup proof, and source
   reactivation only after the cross-owner protocol is specified.
5. Run the all-owner move against isolated PostgreSQL/Kafka and assert duplicate
   provider sends, lost lifecycle events, and stale-epoch writes are rejected.
