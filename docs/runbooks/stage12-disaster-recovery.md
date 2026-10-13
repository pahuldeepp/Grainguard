# Stage 12.13 disaster recovery procedure

Status: local fixture validation only; service and regional recovery remain
unverified. The [platform ownership and recovery contract](../PLATFORM_CONTRACTS_AND_OPERATIONS.md)
is the source of recovery invariants. This runbook supplies operator steps, not
authorization to run them on a shared environment.

## Prerequisites and incident record

The incident commander coordinates the database, streaming, service, security,
and infrastructure owners. Assign named operators and a reviewer before an
environment recovery; named on-call assignments remain a deployment prerequisite.
Record incident ID, affected tenants/cell/region, last acknowledged receipt IDs,
failure time in UTC, source and target identities, approved recovery point,
schema/image/contract/model versions, placement epoch, backup checksums and
retained event/WAL intervals. Keep tenant payloads, credentials and dumps in
restricted evidence storage; publish only redacted counts and identifiers.

Before restoring, require:

- An independent target with capacity and network policy to prevent contact with
  live databases, brokers, webhooks, billing/delivery providers or physical devices.
  Disable dispatchers, saga workers, MQTT commands and ingress until their gates
  pass. Verify target identities and restricted credentials with a second operator.
- A readable backup and its provenance, schema version, compatible PostgreSQL
  tools, restore-role manifest, encryption keys and immutable artifact versions.
  A per-database `pg_dump` is not a coordinated cross-service snapshot and omits
  cluster roles, WAL/PITR and replication-slot continuity. Preserve grants and
  ownership explicitly; do not use the fixture's `--no-owner` as a service policy.
- A recoverable source for each event interval required by derived rebuilds;
  retained outbox rows, Kafka and archives must cover the same dedup horizon.
  Record any missing interval before selecting a recovery point.
- A recovery-point decision by the incident commander and data owners. If keys,
  provenance, source history or capacity are missing, remain fenced and escalate;
  do not call an empty snapshot a successful recovery.

## Ownership and restore order

Use [init-databases.sql](../../infra/compose/init-databases.sql), each owner's
migrations and README to inventory the deployed storage, rather than assuming
every target-design service exists. Current local logical databases include
inventory, telemetry, read, risk, alerts, sagas, hardware, jobs, notifications,
control and billing. None has been restored by the Stage 12 fixture.

| Order | State and responsible owner | Dependency / recovery gate |
|---|---|---|
| 1 | Infrastructure configuration, identity/secrets and contract/model artifacts; platform/security owners | Independent target and decryptable backups; preserve Terraform state separately using its [state-recovery procedure](../../infra/terraform/README.md). Do not apply infrastructure changes merely to repair a state file. |
| 2 | Control-plane tenant membership, placement and billing entitlement authority (`greenguard_control`, `greenguard_billing`) | Confirm the deployed tenancy ownership and one placement writer; keep routing/admission fenced. Recover provider ledger/receipts without charging again. |
| 3 | Inventory and hardware (`greenguard_inventory`, `greenguard_hardware`); device and hardware owners | Restore binding versions, reservations, command receipts and acknowledgement keys before ingest/provisioning can resume. `asset-registry`/`greenguard_assets` is a target-design boundary; current hardware ownership is documented in its [README](../../services/hardware-service/README.md). |
| 4 | Telemetry, risk and alerts (`greenguard_telemetry`, `greenguard_risk`, `greenguard_alerts`); domain owners | Restore accepted observations, dedup receipts, model/config versions, result revisions, rules, acknowledgements and deadlines. Validate references to inventory and source versions. Restore all owner databases before starting interdependent workers. |
| 5 | Sagas, jobs and notifications (`greenguard_sagas`, `greenguard_jobs`, `greenguard_notifications`); workflow/delivery owners | Restore attempts, leases/fencing, inbox/outbox, retry state and provider receipts. Reconcile ambiguous external effects and deadlines before reenabling dispatch; these ledgers are authoritative. |
| 6 | Kafka, Registry and Connect; streaming owner | Validate topic/partition lineage, schemas, retention, source slots and consumer offsets against restored owner state. Replay original identities only after identifying coverage gaps. |
| 7 | Read projections (`greenguard_read`), Cassandra history, search and bounded caches; projection/storage owners | Rebuild into isolated versions from verified sources; compare identities, versions, counts and watermarks. Cassandra is rebuildable only while required history remains recoverable; snapshot/archive gaps require explicit reconciliation. |
| 8 | APIs and consumers, then bounded admission and dispatch; incident commander and service owners | Integrity, tenant isolation, event coverage, fencing and provider reconciliation gates all pass. Compare fresh receipts/lag before expanding traffic. |

These are restore dependencies, not permission to reconstruct authoritative state
from a cache. Billing, saga and notification records must retain completed-effect
identities. Restore outboxes/inboxes with their owning state; do not clear them
to remove duplicates or hide a gap.

## Restore, verify and decide

1. Preserve source evidence and stop/fence affected writers. Keep the former
   writer fenced even if it becomes reachable. Record the old authoritative
   placement epoch and proposed new epoch for the affected placement in the
   incident record. For regional promotion, require verified fencing; if fencing
   cannot be established, do not promote. The control-plane owner must advance
   the authoritative placement epoch to the recorded new epoch after fencing and
   before promotion or traffic release, with enforcement verified in step 7.
   Regional steps below are not yet rehearsed.
2. Restore owner databases into clean targets using the selected backup/PITR
   process and compatible schema. Recreate approved roles, owners and grants
   separately. Keep application traffic blocked. Capture command exit codes,
   timestamps, backup identifiers and restore logs without secrets.
3. Compare schema/migration versions, row and per-tenant counts, primary/foreign
   keys, receipt/event IDs, stream/binding versions and outbox/inbox coverage to
   the chosen source manifest. Run owner domain checks for reservations, saga
   transitions, alert acknowledgement and delivery/usage identities. A count
   match alone is insufficient: reconcile every acknowledged receipt in the
   selected interval, recording missing or conflicting identities.
4. Inspect restored RLS policies, FORCE/ENABLE flags, grants and runtime roles
   (non-owner, non-superuser, non-BYPASSRLS). Query as the actual runtime roles:
   tenant A sees only A, tenant B sees only B, absent tenant context sees none,
   and foreign-tenant writes fail. Exercise application filters and transaction
   pooling separately before accepting service recovery. Any isolation failure
   stops promotion and escalates to the security and database owners.
5. Follow [WAL retention and CDC recovery](../WAL_RETENTION.md) if slots/WAL or raw
   offsets are lost. Preserve offsets and checkpoints first; establish fresh
   connector/slot identities against restored sources when continuity cannot be
   proved. Replay retained outboxes with original event IDs/tenant/version/payload.
   Stop on conflicting payloads or missing history. A fresh snapshot cannot
   recover already deleted outbox history.
6. Rebuild derived views in independent targets. The [projection replay procedure](../../services/projection-builder/README.md)
   requires a provisioned/migrated `greenguard_read_replay_<name>` shadow and
   restricted `PROJECTION_REPLAY_DATABASE_URL`; use `rebuild <tenant> --dry-run`,
   then `rebuild`, `status` and `compare` through
   `node --env-file=.env scripts/projection-replay.mjs`. Its finite comparison
   is not a promotion gate and does not prove cold history or notification rows.
   Use the owner's separate fenced promotion checks, validate retention and
   deletion/tombstone behavior, and keep the former read version for rollback.
7. Reconcile physical commands, provider attempts, webhooks, charges and delivery
   outcomes with external owners before releasing workers. Unknown outcome means
   manual reconciliation, not resend. Verify fresh binding/entitlement feeds,
   all expected partitions and acceptable backlog before admission. Confirm that
   the control-plane owner advanced the authoritative placement epoch to the
   recorded new epoch after fencing the former writer. Before promotion or
   traffic release, verify routing and every resumed writer enforce the new epoch
   and reject the old epoch; preserve the old/new epochs and enforcement evidence
   in the incident record. Missing advancement or enforcement blocks promotion
   and admission and escalates to the control-plane/platform owners. This gate
   remains required even if the former writer is unreachable.
8. Record the review decision and resume bounded traffic only after all gates
   pass, including the placement-epoch gate. If discrepancies persist, fence the
   target and retain both versions; revert routing only to a verified owner with
   a safe epoch. Failback requires
   reverse reconciliation and fencing, not DNS changes alone.

Escalate unrecoverable backup/WAL gaps to database and streaming owners, domain
conflicts to the service owner, unknown provider effects to delivery/billing
owners, and split-brain or missing keys to platform/security owners. The incident
commander records accepted loss or keeps service unavailable; a gate failure
must not be relabeled as a successful recovery.

## Repeatable local checks (no shared data)

From the repository root, use a running local Docker daemon, Bash, Node and
already cached `postgres:16-alpine`. Ensure `work/` exists and no concurrent
rehearsal uses the PID-named container resources. Do not set
`STAGE12_POSTGRES_IMAGE` to an uncached image.

```bash
docker image inspect postgres:16-alpine --format '{{.Id}}'
bash -n scripts/stage12-postgres-restore.sh
bash scripts/stage12-postgres-restore.sh
node --test scripts/recovery.test.mjs
docker ps -a --filter name=greenguard-stage12-backup --format '{{.Names}}'
```

The restore script checks the local image before running; no pull/install or
Compose startup is needed. It creates PID-named source/target containers without
host ports or shared volume mounts, dumps a synthetic table, restores into a new
database and checks non-owner tenant counts `2`, `1`, `0`. Its EXIT trap removes
its containers and temporary dump directory; anonymous Docker volumes are not
explicitly removed by the existing script. Do not run a global volume prune.
The four recovery unit tests inject SQL/command fixtures for WAL and checkpoint
reset checks; they do not invoke the shared databases. A successful run should
leave no rehearsal containers. If interrupted before cleanup, identify only the
containers belonging to that run before removing them.

The fixture uses trust authentication and synthetic data; it is not a secure
service restore template. Do not run `make db-up`, `make events-up`, live replay,
`make binding-feed-reset`, or live Cassandra/Kafka suites for this local check.
The checkpoint reset command mutates telemetry state and requires stopped
admission/consumer plus a planned replay; passing its fixture test is not an
environment reset approval.

## Evidence and outstanding qualification

See [local restore evidence](../../evidence/STAGE_12_BACKUP_RESTORE_LOCAL.md).
The 2026-09-27 repeat passed in 3 seconds with 4/4 recovery unit tests. The
script's elapsed value covers fixture startup, dump, restore and verification;
it starts before these steps and ends before cleanup. It is not service RTO,
and the static fixture does not measure lost writes or RPO.

For a qualified exercise record failure/last-good-receipt time, selected backup
point, newest recovered acknowledged receipt, first verified service response,
full backlog catch-up, and failback completion. Report missing acknowledged IDs
and their time interval as measured data loss; report failure-to-verified-service
and failure-to-full-catch-up separately. The proposed regional RPO ≤ 5 minutes
and RTO ≤ 30 minutes remain unapproved/unmeasured design objectives.

| Pending qualification | Required evidence |
|---|---|
| Actual service PostgreSQL databases | Coordinated restore manifests, real migrations/roles/RLS/application checks, domain receipts and cross-service reconciliation; full/WAL/PITR backup coverage. |
| Kafka/Registry/Connect and Cassandra | Broker/offset/schema recovery, archived-event coverage and retention gaps; Cassandra snapshots/restore/repair and history comparison. [Stage 05c crash replay](../../evidence/STAGE_05C_CASSANDRA_RECOVERY.md) is RF1 consumer recovery, not a backup restore. |
| Managed backups and key recovery | Owned RDS/Aurora or other selected provider process, encrypted backup access, clean-account/credential/key recovery, immutable archive checks, S3 versioning and DynamoDB PITR where deployed. |
| Measurable RPO/RTO | Named owners, approved objectives, representative data/load, timed failure/restore/catch-up and acknowledged-write loss accounting. |
| Regional recovery and failback | Independent regional target, routing/identity/provider recovery, old-writer fencing, placement-epoch advancement, replica/MirrorMaker2 lineage, measured failover/failback and split-brain prevention. |

Stage 12.13 remains in progress. Do not mark completion or production readiness
from this procedure or the local fixture.
