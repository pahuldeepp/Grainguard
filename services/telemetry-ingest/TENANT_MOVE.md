# Telemetry tenant move adapter

Telemetry now has owner-local target preparation, source fencing, copy receipt,
activation, target cleanup, and source reactivation procedures in migration
`000019_tenant_move_receipts.up.sql`. They are executable only by
`telemetry_migrator`; the operation ledger is not readable by the runtime roles.
The adapter in the tenant control plane calls the owner procedures and checks
their operation, owner, shard, incarnation, epoch, phase, and state fields.

The current telemetry tenant table inventory contains twelve nonpartitioned
tables. The adapter checks the exact inventory on both endpoints and refuses
schema drift or partitioned relations. Snapshot transfer uses 500-row keyset
batches, a source `REPEATABLE READ READ ONLY` transaction, and a single target
transaction. It fences the source before reading, copies foreign-key dependencies
in order, re-reads the target rows, and compares canonical SHA-256 digests and
per-table row counts. Target copy evidence is written through the telemetry
owner procedure in the same transaction as copied rows; a failed receipt write
rolls back the target rows. The target database independently checks its owner
row, table inventory, and total tenant row count before recording that receipt.

Target activation is permitted by the adapter only after the control-plane route
is `activating` at the target shard and next epoch. Abort is allowed only before
activation: it removes the target tenant slice under an operation-bound target
capability, emits an `absent` receipt, and then reactivates the source at the
advanced epoch. The local acceptance runs these paths in a fresh Docker
PostgreSQL instance:

```sh
node scripts/telemetry-tenant-move-local.mjs
```

This acceptance proves only the telemetry owner database protocol. The script
does not mutate the shared development databases. It does not prove global
placement CAS, read-lease draining, or coordination with the other eight
sharded owners. The global mover must continue to fail closed until adapters for
projection, jobs, saga, hardware, inventory, alerts, risk, and notifications are
implemented and the controller gathers their database-derived receipts. The
copy hashes are computed by the trusted migration adapter from direct source and
target query results; the target procedure independently verifies target owner
identity, schema table count, and row count, but does not recompute SHA-256 inside
PostgreSQL.
