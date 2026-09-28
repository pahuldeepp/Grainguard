# Stage 12 inventory tenant move owner acceptance — 2026-09-28

Ran `node scripts/inventory-tenant-move-local.mjs`. The harness built the tenant
control plane, started one uniquely named `postgres:16` container with random
local-only credentials in a mode-0600 temporary file, applied all 22
device-service Prisma migrations, created a second shard database from the
migrated schema, and removed the container and temporary directory in
`finally`. It does not load `.env`, use the shared Compose database, or access
AWS.

The isolated acceptance passed these owner-local checks:

- Exact 15-table schema gate across source and target.
- Four-row site/bin/device/tenant snapshot copy with matching digest and a
  durable copy receipt committed with the copied rows.
- Idempotent replay returns the existing verified receipt.
- Target abort removes copied rows and target ownership; source reactivation
  advances its epoch while retaining source data.
- The adapter and SQL source-fence procedure both reject any historical CDC
  outbox row and any pending inventory saga-result event.

## Limitation

This does not complete global tenant migration. The inventory adapter is not
wired into the control-plane coordinator or accepted as one of its global
owner receipts. More importantly, a tenant with any `outbox_events` history is
intentionally ineligible for this copy procedure: copying those rows can replay
Kafka/CDC effects. A deduplication-aware outbox transfer or archive/replay
protocol is required before ordinary tenants with device history can move.
Cross-owner coordination, live production topology, and the other owner
adapters remain outside this owner-local proof.
