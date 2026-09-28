# Stage 12 Saga and Hardware tenant move audit — 2026-09-28

## Status

**Saga and Hardware are not accepted tenant-move owners. No adapter, copy, or
successful owner receipt is claimed.** The exact nine-owner placement gate
requires independently supplied receipts for both owners; the existing
placement gate rejects an incomplete receipt set. Keep tenant cutover blocked
until these owner protocols and the shared cross-owner barrier are implemented
and exercised on isolated infrastructure.

This is a source/migration audit only. It did not connect to a database, Kafka,
MQTT broker, cloud account, or the shared Compose stack.

## Saga owner inventory and constraints

The current tenant-keyed Saga tables in migrations `000001`–`000007` are:

- `provisioning_sagas`
- `saga_command_outbox`
- `saga_result_inbox`
- `saga_audit`
- `saga_dispatch_tenants`

`saga_shard_leases` is global worker infrastructure, not a tenant row set to
copy. A move must transfer/recompute the tenant's dispatch registration while
preserving the global lease/fencing semantics.

The database records durable commands/results, but execution crosses the
`greenguard.saga.commands.v1` and `greenguard.saga.results.v1` Kafka topics and
three participant owners (Hardware, Inventory, and Telemetry). A database-only copy cannot establish that a command
already published to Kafka has not executed, that a late result cannot mutate
the copied state, or that the result consumer group has crossed a known tenant
boundary. In-flight/compensating/repair-required sagas also have externally
visible provisioning effects. No Saga owner adapter currently binds those
facts to a move operation, source/target epoch, durable receipt, or abort proof.

Required before acceptance:

1. Stop new tenant saga starts and dispatch for the move operation; drain or
   reach an explicit terminal/repair state for every in-flight saga.
2. Fence source database writes and coordinate already-published command and
   result records, participant receipts, Kafka offsets, and any late results.
3. Copy the reviewed tenant tables and dispatch mapping under a recorded
   operation/epoch, verify counts/content, and persist target activation and
   abort-cleanup receipts in the Saga database.
4. Prove stale workers/results cannot advance old epochs and that compensation
   or repair after cutover still reaches the correct participant state.

## Hardware owner inventory and constraints

The current tenant-keyed Hardware tables in migrations `000001`–`000004` are:

- `hardware_assets` (includes `mqtt_ack_secret`)
- `hardware_command_receipts` (includes pending configure payloads and dispatch
  metadata)
- `hardware_result_outbox` (Kafka publication state)

Hardware operations leave PostgreSQL: configure commands are retried through
MQTT until device acknowledgement; device acknowledgements are authenticated
using the per-asset secret; definitive results are published to Kafka. A
`pending`/`cancelled` receipt, unpublished result, in-flight broker delivery,
or late device acknowledgement cannot be treated as inert copied data.
Transferring `mqtt_ack_secret` also needs an explicit protected transfer and
device/broker continuity decision. Current placement routing in the worker
selects a database for current tenant placement, but it is not a tenant-move
protocol and produces no prepare/fence/copy/activate/abort receipts.

Required before acceptance:

1. Establish a tenant-scoped quiesce/drain for MQTT dispatch and acknowledgement
   handling that survives worker restart, and reject migration while configure
   receipts or result outbox effects remain unresolved.
2. Define an authenticated secret transfer/rotation procedure, avoiding secret
   exposure in logs, evidence, or generic copy diagnostics.
3. Fence the source, copy the exact hardware tables, verify the target receipt,
   and prove late acknowledgements and stale workers cannot mutate either
   shard after epoch advancement.
4. Coordinate Hardware receipts with the Saga owner operation so provisioning
   cannot be cut over while the participant is still executing on the source.

## Global cutover dependency

Even complete owner-local procedures are insufficient alone. The Tenant Control
Plane must stop new admissions and read/write leases, drain them, and commit one
placement epoch only after every operational owner has a database-derived
receipt. Saga and Hardware currently have no such adapters. Do not synthesize
receipts from structural table copies or mark these two owners complete from
unit fixtures.

## Evidence

- The authoritative nine-owner roster is in
  `services/tenant-control-plane/src/domain/placement.ts` and
  `infra/gitops/disposable/owner-migration-inventory.json`.
- Saga tables and cross-shard dispatch infrastructure are defined in
  `services/saga-orchestrator/migrations/000001_authority.up.sql` through
  `000007_trace_context.up.sql`.
- Hardware receipt, secret, retry/finalization, and result-outbox behavior are
  defined in `services/hardware-service/migrations/000001_hardware.up.sql`
  through `000004_result_trace_context.up.sql`, and summarized in
  `services/hardware-service/README.md`.
- The exact-owner placement gate is tested in
  `services/tenant-control-plane/src/domain/placement.test.ts` and
  `placement-owner-gate.test.ts`; this audit did not rerun those tests.
