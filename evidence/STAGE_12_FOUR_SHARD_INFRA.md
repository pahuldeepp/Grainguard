# Stage 12 four-shard infrastructure evidence

Scope: Task 4 infrastructure foundation, independent of live AWS acceptance.
No real AWS plan/apply/destroy or production operation ran. No commit was made;
the parent integration gate owns the final scoped commit.

Local proof: four independent primary + real physical standby pairs started
from empty dedicated fixture volumes. All nine operational owner migrations
ran on every bundle (36 migration invocations), excluding central control and
billing. [Fresh startup](stage12-four-shard/fresh-startup.log) and
[SQL smoke](stage12-four-shard/local-smoke.log) prove physical system identity,
replica ownership, schema/RLS parity, owner credentials, cross-tenant denial,
cross-shard absence, read-only standby, actual replay lag and catch-up on s1-s4.
A newly cloned scratch standby separately verified private backup credential
cleanup, no password in recovery config and persistent passfile mode0600.
The documented selected-standby recovery path was exercised on s2: stop its
standby, recreate only its physical slot, clear its completion marker, obtain a
fresh base backup and recover healthy streaming; all-four smoke passed again.
[Rebuild proof](stage12-four-shard/replica-rebuild.log) records actual backup
recovery and streaming. This exercised replacement after an explicitly recreated
slot; it did not generate 2GB of WAL to induce the retention limit itself.
Generated containers/networks were stopped; volumes were retained. Central
Compose was never started, stopped or mutated by this harness.

Static/offline proof: Terraform fmt/validate; standalone Compose rendering;
RDS bootstrap canonical SQL-copy/TLS checks; legacy data-plane Argo checks;
new `check-shards.rb` four-shard child/TLS/Secrets/central-exclusion and reject
fixtures; 12 connector registration tests; [50 teardown stubs](stage12-four-shard/teardown-stubs.log).
The teardown wrapper captures each managed shard secret before erasing state,
including failed updates with stale root outputs. These stubs verify scripts,
not AWS deletion behavior.

Terraform represents 4 operational primaries + 4 default replicas + existing
central instance = **9 RDS instances**. It owns four sets of bootstrap/migrator/
PgBouncer/CDC Secret containers and ten service-specific routing containers,
without storing credential values. Argo consumes four shard descriptors for
bootstrap and distinct poolers. Shared Connect receives per-shard credentials;
registration maps 20 operational and 3 central connectors, preserving canonical
raw topics and independent shard source prefixes/slots.

CodeRabbit initial Compose/GitOps findings were corrected across review rounds:
dedicated replication password/shared startup settings, private backup passfile,
restricted local/socket/replication HBA, bounded resource names, operational
bootstrap revision hashing, duplicate endpoint rejection, immutable connector
source identity, and safe explicit central connector retirement. Removing a
registry while shard sources exist now fails closed instead of deleting live
sources merely because configuration disappeared. The latest rereview returned further actionable findings, now corrected:
completed-basebackup marker, streaming/replay health, exact-case source identity,
explicit bootstrap PGHOST binding and receipt-content revision. The Compose
review also ended with a WebSocket connection error. Subsequent completed reviews
identified the bounded-WAL replica recovery procedure and missing-host operational
bootstrap rejection; both are corrected and validated. The final post-fix
[GitOps review](stage12-four-shard/coderabbit-gitops.jsonl) completed with zero
findings. The post-fix [Compose review](stage12-four-shard/coderabbit-compose-interrupted.jsonl)
again failed with the external WebSocket subscription error before findings.
A serialized Compose retry is running; no clean Compose result is claimed.

Remaining required integration: authenticated control-plane placement import,
owner-local fencing seed/audit, application/worker shard routing and aggregate
pool budgets, per-owner migration image Jobs and least-privilege Secret
materialization on EKS, real Kafka/CDC source identity proof, replica/cache
freshness, tenant migration, AWS health/E2E and verified teardown. The harness
now has `verify-fences` and invokes it after migration; this new post-migration
hook has not yet run against all four bundles with Task 3 migrations installed.
Bootstrap only creates the NOLOGIN import role; it never guesses tenant routes
or marks an operational shard active. Runtime pods must remain blocked until
trusted import succeeds.

See [operating instructions](../infra/compose/SHARDING.md).
