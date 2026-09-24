# Stage 05a projection-builder validation

2026-09-24 retention-fix working tree. No commit or push. This report records the
commands run for this change; it does **not** mark Stage 05a complete or establish
live SQL/RLS correctness. Migration 000002 has **not** been applied to the shared
dev database; the coordinator owns that step.

## Implemented changes

- The cross-tenant INSERT regression asserts `pgconn.PgError.Code == 42501`;
  the following foreign-key assertion expects `23503`. RLS denial remains a hard,
  non-quarantined error, with an offline no-offset-commit regression test.
- Forward-only 000002 preserves existing history while converting it to daily UTC
  partitions. Inbox identities replace history FKs for latest/notifications;
  inbox uniqueness retains reading/version identity after partition expiry.
- Configurable hot window (24h default, 1h minimum, 90-day maximum), three-day
  default ahead creation, one-hour drop safety margin and bounded `cmd/maintain`
  using the migrator role. Runtime has no DELETE/DDL/maintenance execution grant.
- Shared/exclusive transaction advisory locking coordinates inserts and pruning.
  Late observations still update latest/gaps/inbox/notifications/checkpoints but
  skip history and increment a committed-skip metric. Missing in-window partitions
  fail hard with `55000`; runtime cannot create historical partitions on replay.
- New scratch-database tests cover migration copy, expiry, partition creation,
  idempotent maintenance, boundary admission, late/duplicate handling, durable FKs,
  post-expiry identity conflicts, direct-partition tenant isolation and no DELETE.
  These tests compile but their SQL assertions have **not run successfully** here.

## Passing offline checks actually run

From the repository root, with database variables unset:

```sh
GOCACHE=/private/tmp/greenguard-projection-go-cache GOFLAGS=-mod=mod GOPROXY=off \
  go -C services/projection-builder test -race -cover \
  -coverprofile=/private/tmp/projection-retention.cover ./...
GOCACHE=/private/tmp/greenguard-projection-go-cache GOFLAGS=-mod=mod GOPROXY=off \
  go -C services/projection-builder tool cover -func=/private/tmp/projection-retention.cover
GOCACHE=/private/tmp/greenguard-projection-go-cache GOFLAGS=-mod=mod GOPROXY=off \
  go -C services/projection-builder vet ./...
GOCACHE=/private/tmp/greenguard-projection-go-cache GOFLAGS=-mod=mod GOPROXY=off \
  go -C services/projection-builder build ./...
```

Final race/coverage output:

```text
ok  greenguard.local/projection-builder              15.079s coverage: 98.6% of statements
ok  greenguard.local/projection-builder/cmd/maintain   5.171s coverage: 100.0% of statements
ok  greenguard.local/projection-builder/cmd/migrate    3.685s coverage: 87.5% of statements
ok  greenguard.local/projection-builder/history        7.197s coverage: 100.0% of statements
ok  greenguard.local/projection-builder/migrations     8.558s coverage: 94.1% of statements
```

Aggregate statement coverage: **98.6%**. No coverage exclusions or dependency
changes were added. Vet and build exited 0 with no diagnostics. Go coverage does
not measure SQL execution or prove partition/RLS semantics.

Offline tests exercised all maintenance/configuration Go branches, timeout/error
handling, transaction failure boundaries, committed-only late counters, duplicate
no-op counters, metrics exposure and hard RLS failure handling. The existing
projection/kfake/tenant-seam suite also passed with the race detector.

`gofmt` was run on changed Go files. Prettier was run only on the service README,
new ADR and this evidence document. No unrelated files were formatted.

## Database attempts and explicit skips

Before editing, loaded the existing `.env` without printing credentials and ran:

```sh
set -a; . ./.env; set +a
cd services/projection-builder
GOCACHE=/private/tmp/greenguard-projection-go-cache GOFLAGS=-mod=mod GOPROXY=off \
  go test -race -cover ./...
```

It failed on the live tests before SQL because loopback access was denied:

```text
127.0.0.1:55432: connect: operation not permitted
127.0.0.1:56432: connect: operation not permitted
```

After implementing the retention tests, tried only the new scratch-database tests
with the same `.env` and Go environment:

```sh
go test -run '^TestDatabaseHistory' -count=1 -v .
```

All four failed at their initial admin connection, before creating a database or
executing SQL, with `127.0.0.1:55432: connect: operation not permitted`:

- `TestDatabaseHistoryPartitionMaintenance`
- `TestDatabaseHistoryLateReplayAndMovedForeignKeys`
- `TestDatabaseHistoryMigrationPreservesDataThenPrunes`
- `TestDatabaseHistoryInboxIdentityAfterExpiry`

A separate verbose selection, **without** loading `.env`, explicitly showed skips:

```sh
GOCACHE=/private/tmp/greenguard-projection-go-cache GOFLAGS=-mod=mod GOPROXY=off \
  go -C services/projection-builder test -v \
  -run 'TestDatabase|TestWithTenantDoesNotLeak|TestRunAppliesMigrations|TestMainSucceeds' ./...
```

Skipped: the four new tests above; `TestDatabaseMigrations`,
`TestDatabaseProjectionReorderCrashReplayIsolation`,
`TestDatabaseInventoryGapEnrichment`, `TestWithTenantDoesNotLeakOnPooledConnection`,
`TestRunAppliesMigrationsIdempotently`, and
`TestMainSucceedsAgainstTheLocalDatabase`. Each reported its missing database
environment variable. These skips are not passing live evidence.

## Review and remaining validation

Actually attempted `coderabbit review --agent`; it exited 1 before review:

```json
{"type":"status","phase":"auth","status":"starting_login"}
{"type":"error","phase":"auth","status":"authentication_failed","message":"Failed to start server. Is port 0 in use?"}
```

No CodeRabbit review verdict was obtained. Sonar scanning was not run, so its
complexity/duplication/hotspot quality gate is **unverified**. New production Go
helpers were kept small; this is not a substitute for the scanner.

Not run: `make verify`/`make coverage` (they launch Docker and migrate other
services and the shared read DB, outside this scoped/coordinator-owned change),
Docker image build, Sonar targets, live Kafka/Cassandra, transport acceptance,
P01–P06 or a deployed maintenance scheduler. Module vet, build and race checks
above were used instead; no repository-wide pass is claimed.

Coordinator follow-up: apply 000002, rerun all live module tests, verify CodeRabbit
and Sonar gates, and deploy the maintenance job with the same boundary config as
consumer/future query routing. Review Proposed ADR-0011's one-hour margin, 90-day
configuration cap and scheduler cadence. Source telemetry deletion still requires
a Cassandra confirmation watermark and is not implemented by this change.
