# Stage 12.13 — local PostgreSQL restore rehearsal

## Result

`scripts/stage12-postgres-restore.sh` passed on 2026-09-26 using the locally
cached `postgres:16-alpine` image. It created isolated temporary Docker
containers, dumped a synthetic database in PostgreSQL custom format, restored
it to a clean database, and removed the temporary containers and files.

The restored rows matched the fixture: tenant A saw two records, tenant B saw
one, and a tenant with no matching policy value saw zero. The fixture enabled
and forced row-level security and queried as a non-owner role. Restore elapsed
time was 5 seconds in this local run.

## Limits

This proves the local PostgreSQL dump/restore path and preservation of the
fixture's RLS table/policy. It does not exercise GreenGuard's actual managed
database instances, Kubernetes persistent volumes, Kafka or Cassandra state,
encryption/key recovery, point-in-time recovery, regional failover, monitoring,
or operator-approved RPO/RTO objectives. Stage 12.13 remains in progress until
owned stateful services have documented objectives and recovery evidence.

## Repeat and recovery asset validation — 2026-09-27 UTC

The [Stage 12 recovery runbook](../docs/runbooks/stage12-disaster-recovery.md)
adds operator prerequisites, owner restore order, integrity/isolation checks,
reconciliation, escalation and explicit qualification gaps. The cached image ID
was `sha256:721873c34ceb9f8d8fc265984940dc982404c105f19ad51be9fdc5970a6080ea`.

Commands from the repository root:

```bash
docker image inspect postgres:16-alpine --format '{{.Id}}'
bash -n scripts/stage12-postgres-restore.sh
bash scripts/stage12-postgres-restore.sh
node --test scripts/recovery.test.mjs
docker ps -a --filter name=greenguard-stage12-backup --format '{{.Names}}'
```

Observed output (all commands exited 0):

```text
CREATE ROLE
CREATE TABLE
ALTER TABLE
ALTER TABLE
CREATE POLICY
GRANT
INSERT 0 3
Restore rehearsal passed: tenant counts and RLS isolation match; restore elapsed 3 seconds.
✔ WAL requires both configured slots, including a partially missing stack
✔ only the explicit empty-stack flag permits no slots
✔ WAL retains configuration and retention failure checks
✔ checkpoint reset requires exact confirmation and targets telemetry only
tests 4; pass 4; fail 0; skipped 0
```

The final container inventory was empty. No shared Compose service, database or
broker was changed and no image/dependency was pulled or installed. Recovery unit
tests inject query/command fixtures rather than calling shared resources. The
rehearsal's elapsed value includes startup/dump/restore/verification and excludes
cleanup; it is not service RTO or measured RPO. The existing cleanup removes
containers and the temporary dump directory, but does not explicitly remove
anonymous Docker volumes. No global volume cleanup was attempted.

Reviewed assets: `infra/compose/init-databases.sql` (service databases/roles),
`docs/PLATFORM_CONTRACTS_AND_OPERATIONS.md` (authority/recovery contract),
`docs/WAL_RETENTION.md`, `scripts/wal-check.mjs`,
`scripts/binding-feed-reset.mjs`, `scripts/projection-replay.mjs`,
`services/projection-builder/README.md`, `services/hardware-service/README.md`,
`infra/terraform/README.md` and `evidence/STAGE_05C_CASSANDRA_RECOVERY.md`.
Live WAL/reset/replay/Kafka/Cassandra commands were not run. These assets describe
recovery capabilities and restrictions; their presence does not qualify backup,
managed-service or regional recovery.
