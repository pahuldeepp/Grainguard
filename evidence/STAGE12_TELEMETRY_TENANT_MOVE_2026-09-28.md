# Stage 12 telemetry tenant-move acceptance (2026-09-28)

## Scope and result

**Telemetry owner only: local acceptance passed.** This is not tenant-wide or
Stage 12 migration acceptance. The global mover must remain fail-closed until
the other eight database owners provide their own database-derived receipts:
projection, jobs, saga, hardware, inventory, alerts, risk, and notifications.

The acceptance used a uniquely named, disposable Docker PostgreSQL instance,
ran telemetry migrations as `telemetry_migrator`, and cleaned up the scratch
container afterward. It exercised owner-local source fencing, target
preparation, copy and durable receipt, idempotent receipt replay, target
activation, stale-source-writer rejection, target writes, target abort/cleanup,
and source reactivation at the advanced epoch. It did not touch shared
development databases, AWS, or Terraform.

## Checks

| Check | Result |
| --- | --- |
| `node scripts/telemetry-tenant-move-local.mjs` | Passed against disposable PostgreSQL. |
| `npm run build -w @greenguard/tenant-control-plane` | Passed. |
| `node --test services/tenant-control-plane/dist/tenant-move/pg-owner.test.js services/tenant-control-plane/dist/tenant-move/telemetry-owner.test.js` | Passed: 4 tests. |
| `cd services/telemetry-ingest && go test ./migrations ./cmd/migrate` | Passed. |
| `node --check scripts/telemetry-tenant-move-local.mjs` | Passed. |
| `git diff --check` | Passed. |
| `npm test -w @greenguard/tenant-control-plane` | Not run: this package's broader suite may touch shared database state. |

Scratch-container cleanup was checked after the local acceptance; no matching
`gg-telemetry-move` container remained.

## Proof boundary

The telemetry adapter verifies the twelve-table owner inventory, rejects
partitioned/schema drift, pages snapshot rows in bounded batches, compares
source/target canonical digests and per-table counts, and commits the
database-derived target receipt in the same transaction as copied rows. Its
owner procedures guard the telemetry copy/fence/activate/abort protocol.
The digest comparison is performed by the trusted adapter using direct DB
reads; PostgreSQL independently validates target ownership, inventory, and
row count, but does not independently recompute the SHA-256 digest.

This evidence does not establish global placement compare-and-swap, control
plane read-lease draining, or all-owner cutover/abort. No receipts were
synthesized for other owners, and this adapter has not been represented as
integrated into an all-owner migration acceptance.
