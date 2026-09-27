# Stage 10c — MySQL inventory snapshot and CDC

## Objective
Import legacy partner sites, bins, and devices into GreenGuard using MySQL 8, Debezium snapshot/binlog CDC, and a tenant-authenticated Device Service import command. PostgreSQL remains canonical. The importer has no canonical database credentials and never writes canonical tables directly.

## Constraints and decisions
- Partner tenant keys map through trusted configuration to GreenGuard tenant principals; payload tenant fields never establish tenant identity.
- Partner entity IDs map deterministically to canonical UUIDs using source ID, tenant ID, entity type, and external ID.
- Use one fixed connector/topic generation and entity partitioning contract. Offsets are comparable only within that exact topic/partition; changed connector generations or partitions must fail closed rather than silently overwrite newer data.
- Import receipt/fence, domain mutation, audit, and existing canonical outbox event commit in one Device Service/PostgreSQL transaction.
- Same source coordinate + same digest is idempotent. Same coordinate with a different digest is rejected. Older source changes are acknowledged stale with no mutation/event.
- Device deletes map to the existing soft-deleted device status. Facility deletion/relocation has no safe canonical lifecycle contract yet and is quarantined for operator handling; it must not cascade destructive updates.
- No real partner credentials or cloud/AWS work. Local MySQL, Kafka/Connect, Postgres/PgBouncer and fake/authenticated Device Service integration are sufficient for local acceptance.

## Sequential tasks
1. **Partner schema and import contract:** versioned SQLAlchemy Core/Alembic source schema for sites/bins/devices; strict Debezium envelope normalizer; stable canonical IDs; trusted tenant mapping; source coordinate and digest. Test malformed/oversized values, tenant spoofing, unsupported tables/fields, deletes, and deterministic identity.
2. **Atomic Device Service admission:** tenant-bound service principal and import API; RLS-protected import state/receipt; row/advisory fencing; atomically apply allowed inventory commands, audit and existing outbox. Test duplicates, stale/reordered/replayed changes, rollback, concurrent admission and two-tenant isolation against local PostgreSQL.
3. **Importer runtime:** Kafka consumer with manual commits, admission HTTP client, bounded retry, graceful shutdown, durable raw-byte DLQ with confirmed publish before offset commit, poison handling, and same-coordinate redrive. Test crash after API commit before Kafka commit, DLQ publish failure, outage/backlog replay, partition rebalances and parent dependency behavior.
4. **Opt-in live profile:** pinned MySQL 8 + Debezium MySQL connector, row binlog/full row image, explicit tables and schemas, persistent connector metadata, topic provisioning, `make mysql-cdc-test`, CI live job and saved run evidence. Prove initial snapshot, updates, connector restart, importer crash/replay, stale event fencing, delete behavior, poison/unmapped tenant and cross-tenant isolation.

## Acceptance
- Stage 10c has reproducible unit, database, and live MySQL/Kafka/PostgreSQL commands and saved evidence.
- Snapshot plus CDC lands only through the Device Service import API and emits canonical outbox events once per accepted change.
- Failure before import commits does not advance Kafka; failure after import commit but before consumer offset commit is safe to replay.
- Device Service tenant authentication, RLS and explicit tenant filters prevent cross-tenant reads/writes.
- No claims of external production partner onboarding or managed Debezium HA from local tests.
