# ADR-0013: saga worker coordination with PostgreSQL shard leases

Status: PROPOSED for owner review. Implemented locally in `services/saga-orchestrator`
(migration `000005_shard_leases`, `saga/lease.go`, `cmd/worker`).

## Context

Stage 07 slice 4 asks for leases for worker assignment and fencing tokens checked at every
side effect, with PostgreSQL state, version and uniqueness remaining the authority. The
plan names Redis or etcd. The local saga worker used a static `SAGA_TENANT_IDS` list,
which cannot scale and has no fencing.

## Decision

Use lease rows in the saga authority database instead of Redis for the production path.

- `saga_shard_leases` has 64 rows. A worker takes free/expired shards up to
  `SAGA_MAX_SHARDS` and renews them every TTL/3 (`SAGA_LEASE_TTL_SECONDS`, default 15)
  with a single row-locking `UPDATE`. The fencing token keeps its value on renewal and
  increases on every takeover, including re-acquisition by the same holder after expiry.
  It never resets.
- Every scanning side effect (command publication and deadline compensation) runs
  `Leases.Check` inside the same tenant transaction: `SELECT ... FOR SHARE` on the lease
  row with the holder and token. A takeover uses `FOR UPDATE SKIP LOCKED`, so it cannot
  overlap an in-flight fenced transaction, and a superseded worker fails with
  `ErrLeaseLost` before it publishes or writes.
- Tenants map to shards by the first SHA-256 byte of the tenant ID mod 64
  (`saga.ShardFor`, which matches the SQL backfill). `saga_dispatch_tenants` records that
  mapping when a saga starts, with forced RLS. Workers enumerate only tenants with pending
  work through a fixed, ID-only `SECURITY DEFINER` selector, in pages of 100.
- Result consumption stays fenced by Kafka group generations, the saga row lock, the saga
  version and the per-saga fencing token that participants echo. A result from a
  superseded command is rejected or, after cancellation, reconciled.
- Concurrency choice: pessimistic (row lock plus share lock) for leases; the existing
  partial unique index still decides competing asset claims.

## Why not Redis now

A Redis lease cannot fence a PostgreSQL write by itself. The token would still have to be
checked in the database transaction, so Redis would add a second failure domain and about
64 MB of memory without being the authority. Keeping the lease next to the state makes
the check transactional. This decision is a deliberate deviation from the plan's
"Redis or etcd" wording. The backlog's Redis/etcd coordination exercise stays open as a
lab in Stage 13 (Redis Cluster work is owned there). Nothing on the critical path depends
on it.

## Consequences

- `SAGA_TENANT_IDS` is retired. The worker refuses to start if it is set.
- 64 shards bound the number of active saga workers per cell. Changing the count needs a
  resharding ADR, because the token history is per shard.
- The device-service and telemetry participant workers still use explicit tenant lists
  for their result outboxes. They must move to ID-only selectors before the
  10-million-tenant claim can be tested. This is tracked as open Stage 07 work.
- The lease check adds one indexed primary-key read per side-effect transaction.
