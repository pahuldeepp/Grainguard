# Read scaling: first replica slice

The disposable Terraform profile now defaults to one private PostgreSQL read
replica (`postgres_read_replica_count = 1`). Set the count from zero through
five. Each replica is a separately billed RDS instance, owned by the same
Terraform state and deleted before its source through the source dependency.
No AWS instance has been provisioned or proved healthy yet.

Read API already uses HPA. Scaling API pods and database replicas are separate:
pods handle concurrent requests; database replicas offload read queries.
Database replication is asynchronous, so reads may lag writes. ACK and other
commands keep their existing owning service/writer paths.

## Application connection

`postgres_read_replica_endpoints` exposes endpoint addresses, without passwords.
Terraform passes `READ_REPLICA_HOSTS` and mounts `greenguard-rds-ca` in Read API.
The application derives replica URLs from the existing primary read_query URL,
replacing the host/port and requiring verified RDS TLS. For a deployment outside
this Terraform path, unset hosts and supply `READ_REPLICA_DATABASE_URLS` as a JSON array of
PostgreSQL URLs using the existing `read_query` role, `greenguard_read` database,
`sslmode=verify-full` and `sslrootcert=<mounted RDS CA file>`. The CA file must
exist inside the Read API container. Secret synchronization must carry the existing read_query credential and RDS CA;
this slice does not generate new credentials.
Credentials never belong in Terraform outputs or checked-in tfvars.

The Read API selects eligible replica pools round-robin before exposing a
transaction to application SQL. Each replica has independent health, an idle-error
listener and bounded health probes with exponential retry backoff (500 ms through
30 seconds). One failed replica does not fail readiness when another replica is
healthy. When every replica is unavailable, the configured primary read_query pool
is an allowed read fallback. Primary readiness recovery uses a separate 100 ms
probe interval, a shared in-flight probe and the same bounded timeout; it does
not wait for exponential replica backoff. Readiness remains dependent on the primary connection
for the existing membership/entitlement path. A transaction is never replayed after
application SQL begins.

Replica pool size is five per endpoint per API pod; connection and admission query
timeouts are two seconds. The transaction runner defaults to a five-second admission
deadline shared across replica attempts and at most one primary attempt. Transactions
use `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY`, transaction-local tenant
context and statement timeout. Existing application tenant filters and RLS apply.
Replica shutdown closes all owned replica pools, preserving ownership of the
primary pool. Late connections after timeout/shutdown are discarded.

### Minimum-consistency interface

`ReplicaProvider.acquire({tenantId, minimumSequence?, deadline})` returns a lease
containing a transaction, selected endpoint and commit/rollback operations.
`withTenant(tenantId, callback, minimumSequence?, deadline?)` manages that lease.
`minimumSequence` is `{shardIncarnation, placementEpoch, sequence}` with epoch and
sequence represented as nonnegative decimal strings. The incarnation means the
stable shard/database identity, never a Kafka offset or source WAL position.

The provider checks this durable table in the same repeatable-read snapshot used
for application queries:

```sql
SELECT shard_incarnation, placement_epoch::text, sequence::text
FROM read.projection_watermarks
WHERE tenant_id = $1;
```

The table contract is `tenant_id UUID` (one row per tenant), `shard_incarnation TEXT`,
`placement_epoch BIGINT`, and `sequence BIGINT`, with tenant RLS and read_query SELECT
grants. Projection transactions must serialize on and advance that watermark row
atomically with their read-model changes. The schema, projection producer and
notification-to-cache/request integration belong to subsequent sharding tasks;
this slice implements the consumer/admission boundary, not those producers.

Missing rows, missing table/grants, invalid numbers, old incarnation/epoch and
below-minimum snapshots fail closed. A below-minimum replica attempt rolls back
before application SQL, then another endpoint or the single primary fallback
establishes a fresh snapshot. The API never silently changes a minimum-consistency
request into an eventual read. The primary must satisfy the same projection
watermark; primary placement alone cannot prove asynchronous projection completion.

`postgresReads(provider, {minimumSequence: trustedResolver})` supplies requirements
from a trusted integration. Main currently supplies no minimum requirement, so its
reads remain explicitly eventual. No unverified HTTP token/header is interpreted
as a freshness capability by this slice.

### Redis safety during the integration

Replica-backed PostgreSQL methods bypass Redis hits and fills. A Redis device
version or tenant generation is insufficient to prove that a lagging replica can
fill a newly invalidated key. Cassandra/search caching continues on its existing
path. PostgreSQL caching can be enabled again only when durable version guards,
request/response admission and atomic same-slot fills are integrated and tested.
This prevents stale replica data from refilling Redis; it does not make eventual
replica responses themselves immediately current.

Unset replica variables to retain the original primary read path. Replicas must
have replicated schema, role grants and RLS before traffic is enabled. Unit tests
cover endpoint failures/recovery, deadline cleanup, source-bound sequence checks,
primary fallback before application SQL, no transaction replay, tenant filters,
and the PostgreSQL cache bypass. Physical streaming-replica lag, network outage,
RLS isolation and post-write visibility still require local/live integration proof.

## CDN, partitions and sharding

CloudFront already fronts web and BFF. Web `/assets/*` now has a dedicated
cache policy (one day default, one year maximum, zero minimum TTL), forwarding
no cookies or query strings. Dashboard HTML/config and authenticated APIs keep
caching disabled. Origin asset responses already declare immutable caching;
missing assets must not receive a successful cached SPA fallback.

PostgreSQL reading history already uses daily partitions and per-partition RLS;
Cassandra history uses tenant/device/day partition keys. Redis already supports
tenant-scoped cache keys, invalidation, bounded startup and outage fallback,
and optional Redis Cluster connections.

Cross-database tenant sharding is not implemented by adding replicas. It needs
a durable tenant placement catalog, writer/CDC routing, tenant moves with an
epoch fence, shard-specific migrations, and recovery/teardown ownership.
That remains the next design/implementation slice after replica acceptance.
