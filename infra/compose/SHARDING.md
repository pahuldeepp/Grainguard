# Four operational PostgreSQL bundles

The `sharding` profile has stable IDs `s1`, `s2`, `s3`, `s4`. Each has its own
PostgreSQL primary, physical streaming replica, replication slot, data volumes
and nine operational owner databases. Control-plane identity/membership and
billing remain on the existing central instance. A local database bootstrap
never invents tenant placement or migration epochs.

## Local commands

Run the normal repository bootstrap first (`make bootstrap`, `make risk-venv`).
With a populated ignored `.env`, run from the repository root:

```sh
node scripts/shards-local.mjs up
node scripts/shards-local.mjs migrate
node scripts/shards-local.mjs smoke
node scripts/shards-local.mjs registry
node scripts/shards-local.mjs down
```

`up` starts primaries, reapplies the idempotent role/bootstrap SQL and reloads
HBA, then waits for all eight processes to be healthy. A temporary initialization
server cannot pass primary health before the final TCP listener starts.
`migrate` runs nine owners on each shard: inventory, telemetry, projections,
risk, alerts, jobs, notifications, sagas, hardware. Their existing migration
runners retain migration checksums/locks; control and billing are excluded.
`down` stops only the isolated project and retains volumes. For a fresh fixture,
set `GG_SHARD_COMPOSE_PROJECT=greenguard-sharding-<suffix>` on each command;
stop the previous project first because the loopback ports are shared.

Primaries use ports `57431`–`57434`; replicas use `58431`–`58434`, all bound to
`127.0.0.1`. Replicas use `pg_basebackup`, `standby.signal` and WAL streaming,
not writable copies pretending to be replicas. The password for the dedicated
replication role is generated into ignored mode-0600
`.local/sharding/compose.env`; replicas never receive the raw admin password.
Backup uses a temporary private `.pgpass` file and removes it. Persistent
replication credentials remain in a private data-volume `.pgpass`, not in
`postgresql.auto.conf`. Normal local role passwords come from the existing local
`.env`; the shared test credentials are not an AWS secret-generation policy.

All four primaries bound physical-slot retention with `max_slot_wal_keep_size=2GB`.
If a replica stays offline long enough to lose its retained WAL, it requires a
new base backup; restarting a completed replica alone does not repair that loss.
For the isolated local fixture, select the affected shard and the same project
used to create it, then run:

```sh
shard_id=s2
shard_project=greenguard-sharding
shard_dc() {
  docker compose -p "$shard_project" --env-file .env \
    --env-file .local/sharding/compose.env -f infra/compose/shards.compose.yaml \
    --profile sharding "$@"
}
case "$shard_id" in s1|s2|s3|s4) ;; *) exit 1 ;; esac
case "$shard_project" in greenguard-sharding|greenguard-sharding-*) ;; *) exit 1 ;; esac
shard_dc stop "postgres-$shard_id-replica"
shard_dc exec -T "postgres-$shard_id" psql -U postgres -d postgres -v ON_ERROR_STOP=1 \
  -c "SELECT pg_drop_replication_slot(slot_name) FROM pg_replication_slots WHERE slot_name='gg_replica'; SELECT * FROM pg_create_physical_replication_slot('gg_replica');"
shard_dc run --rm --no-deps --entrypoint /bin/sh "postgres-$shard_id-replica" \
  -c 'rm -f /var/lib/postgresql/data/.gg-basebackup-complete'
shard_dc up -d --wait --wait-timeout 180 "postgres-$shard_id-replica"
```

The next standby startup clears only its dedicated replica data directory and
clones the current primary. This procedure does not remove primary volumes or
logical CDC slots. Require healthy streaming/replay before reads resume. It is
a local fixture recovery procedure; production/AWS recovery uses its own
authorized replica replacement and source-identity protocol.

`smoke` uses fixed synthetic IDs only and cleans up its rows. It verifies:
physical system IDs differ; each standby belongs to its own primary; all nine
owner schemas/RLS settings match; runtime roles cannot bypass RLS; actual
`device_views` writes replicate; different tenant reads return no rows; foreign
shards contain none of those rows; standby writes fail; paused replay exposes
actual lag and resuming catches up. Every pool in the harness is bounded to one
connection and always closed. This is infrastructure/SQL evidence, not proof
that every runtime service routes or that a tenant can migrate end to end.

`registry` writes ignored mode-0600 private files under `.local/sharding`.
`registry.json` is a local admin/migration harness artifact; never mount it into
runtime pods. `{service}.json` files contain only that service's owner-role
credentials and match this interface:

```json
{
  "formatVersion": 1,
  "service": "telemetry-ingest",
  "database": "greenguard_telemetry",
  "shards": {
    "s1": {
      "incarnation": "d1657e54-6bf5-4e4a-851d-01a8c4517b4d",
      "primaryUrl": "private-owner-url",
      "replicaUrls": []
    }
  }
}
```

Actual files contain all four entries. `read-api.json` uses `read_query` on each
primary/replica, never an owner/migrator role. Set
`SHARD_DATABASES_FILE=/etc/greenguard/shards.json` with a service-specific Secret
mount. The local generated `incarnation` is a valid fixture UUID shared by all service
configs, derived from the project, shard ID and physical PostgreSQL system ID.
Recreated physical bundles yield a new identity; fixture onboarding must import
that identity into the central shard registry before activation. AWS runtime
config must use the authoritative durable incarnation exported from that registry.
Active membership, hashing/ring versions and placement epochs belong to the
control plane; Terraform endpoint availability does not make a shard active.

## Disposable AWS representation

`infra/terraform/disposable/read-replicas.tf` represents four encrypted private
RDS primaries keyed by `s1`–`s4` and one replica per shard by default, keyed
`s1-r1`–`s4-r1`. Together with the existing central control/billing instance this
is **nine RDS instances**, not eight total. Counts above one are configurable
per shard up to five; changing counts preserves existing replica keys. Primaries
retain one-day backups; disposable destroy skips final snapshots and deletes
automated backups. Explicit `StorageType=gp3` was removed from read-replica
creation because that RDS API requires IOPS when the type is specified; the
source storage/default is used instead.

`postgres_shards` emits endpoints and secret ARNs only. `shard_routing_secret_arns`
is one Secrets Manager container per runtime service; each holds that service's
own four-shard config, not a shared all-owner credential. Per-shard bootstrap,
migrator, PgBouncer and CDC containers are also owned with zero-day recovery.
Values, RDS master-secret retrieval and Kubernetes materialization remain gated
operator/deployment-tooling work; no passwords enter Terraform state or outputs.

Argo consumes the four-shard values: four bootstrap Jobs select operational-only
SQL, and four PgBouncer Applications expose distinct Services without central
control/billing databases. A shared Connect worker mounts four CDC credentials.
Registration creates 23 connectors: central `control-outbox`, `billing-outbox`,
`notification-contacts`, and each shard's `inventory-outbox`, `telemetry-outbox`,
`risk-outbox`, `alerts-outbox`, `projection-notifications-outbox`. Shard-specific
source prefixes and slot names preserve independent lineage; RegexRouter still
publishes the existing canonical downstream raw topics. Real Kafka/Connect task
health, source-incarnation validation and event-to-runtime routing still require
integration/live acceptance.

Legacy central operational connectors are preserved by default. Retirement is
allowed only after all legacy tenants have moved, legacy writes are fenced,
transfer is verified and the new connector tasks are healthy. An explicitly
mounted `centralRetirementReceiptSecret` must contain `receipt.json` with:

```json
{
  "source": "legacy-central",
  "sourceHost": "exact-old-rds-host",
  "writesFenced": true,
  "transferVerified": true,
  "remainingTenants": 0
}
```

This receipt must be produced from the cutover acceptance, not fabricated to
unblock a deployment. The bootstrap root currently supplies no receipt. Only the
five central operational connector names are deleted; control, billing and
notification contacts stay active. The migration gate/readiness gate remains.

Pre-destroy cleanup depends on every shard/replica/secret so controllers are
removed while databases remain reachable. The verified wrapper captures all
four RDS-managed master secret ARNs before destroy; the inventory checks
case-qualified shard naming independently of tags, manual snapshots, and each
captured master secret. Direct Terraform destroy still lacks a final after-all-
resources inventory; use the existing `destroy-verified.sh` acceptance path.

Outstanding integration: trusted placement snapshot import/ownership seeding;
per-service runtime routing and bounded global connection budgets; per-shard
migration-image Jobs and Secret materialization on EKS; cache/replica freshness;
tenant copy/final delta/fencing/moves; actual broker/CDC proof; AWS apply and
verified destroy. No real AWS operations were performed for this slice.

Connector identities cannot silently change their physical hostname/database,
source prefix or slot name while old offsets exist. Registration rejects such a
change before writing any configs. Removing the shard registry while shard
sources still exist also fails closed; it never deletes active sources merely
because config disappeared. Approved migration/recovery or full disposable
teardown is required to retire a fleet. The local replication HBA rule is scoped
to the configured dedicated network CIDR, `172.30.44.0/24` by default.

The canonical init SQL creates NOLOGIN `tenant_ownership_bootstrap` with SET-role
membership for the bootstrap admin. This role's import function permissions
come from owner migrations. A separate authenticated import principal is not
wired yet. Bootstrap performs no placement import; the future import job must
authenticate the central export and call
`greenguard_internal.seed_tenant_ownership(jsonb,text,uuid,integer)` in each owner DB.
The full snapshot contains authenticated `{tenantId, shardId,
shardIncarnation, placementEpoch, state:'active'}` assignments. The import first
validates the expected local assignment count before changing any fence, then
fences local rows absent from that exact active snapshot and inserts matching
assignments without overwriting conflicts. Compare the returned count again
with the authoritative active-assignment count for that local shard/incarnation;
fail activation if they differ. Runtime pods must remain blocked until that
reconciliation, count check and the fence audit pass. Epoch/incarnation conflicts
require the approved tenant-move or restore procedure.

## Activation and initial placement

Terraform creates capacity; the control plane activates it. Deployment tooling
must collect readiness receipts for primary identity/TLS, all nine migrations,
fence installation audit, authenticated ownership import, streaming replica and
CDC source/task health before any control-plane activation. The receipt set must
match the physical endpoints and UUID incarnations supplied to service files.
Only after that acceptance may a trusted control-plane transaction compare the
registry's previous version/incarnations, activate eligible entries and publish
a new immutable onboarding ring. Existing tenant placement remains unchanged by
ring publication. This post-readiness activation transaction/tooling is required
integration work, not implemented by the Terraform resource graph.

Two bootstraps require different handling:

- **Greenfield disposable cell:** the central control database has no tenant
  placements or accepted operational work. Prove all four new physical bundles,
  register their authoritative UUID incarnations and service bindings, then
  atomically activate s1-s4 and publish the onboarding ring. Block tenant
  onboarding until this succeeds; do not leave a fresh cell with an accidental
  legacy-s1-only ring.
- **Populated legacy upgrade:** logical s1 still owns operational tenant data on
  the old central instance. Bring the new s2-s4 bundles through migration/import/
  CDC readiness and move legacy tenants through the approved fenced protocol.
  Preserve old s1 endpoints and its incarnation while any placements reference
  them. After no tenant or accepted work remains, offline s1, compare the old
  registry incarnation/version, install the new physical s1's incarnation and
  binding, prove its gates, and activate it with a new immutable ring version.
  Repointing populated s1 at an empty new primary is forbidden. Central identity
  and billing remain on their central database throughout this upgrade.
