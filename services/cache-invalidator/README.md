# Cache invalidator

The projection builder inserts a `projection_notifications` row in the same
transaction as its read-model effect. Migration `000009_notification_outbox`
adds an insert-only canonical outbox row through an `AFTER INSERT` trigger.
Debezium connector `projection-notifications` reads only that outbox and writes
`greenguard.raw.projection.notifications`. The CDC transformer validates it and
routes it to `greenguard.projection.notification.v1`. This worker bumps the
Read API's Redis version key for the affected device or tenant.

The worker commits a Kafka offset only after Redis confirms every version bump
in the batch. If Redis remains unavailable after bounded retries, the worker
holds the batch with its offset uncommitted and retries after a bounded wait;
Kafka replays the notification after a crash or restart.
The same Redis script publishes a scoped hint on `gg:read:v1:live` after each
confirmed bump. The BFF filters hints by tenant and device, then refetches the
durable projection. Pub/sub is an ephemeral wake-up signal; reconnects catch up
from the Read API.
An in-memory pending epoch flag is never considered a committed effect. A
successful global epoch bump can supersede lost per-key bumps during one
process lifetime. Read API entries also expire after at most 18 seconds with
the default TTL and jitter.

Tenant IDs and device IDs are validated before constructing Redis keys. A
tenant bump supersedes that tenant's device bumps within a batch; another
tenant's bumps remain independent. There are no tenant labels in metrics.

Local checks: `cd services/cache-invalidator && go test -race ./...`. The opt-in
`TestLiveKafkaRedisCommittedInvalidation` uses a unique Kafka consumer group and
unique Redis keys, and requires `CACHE_INVALIDATOR_LIVE=1`, `KAFKA_BROKERS`,
and either `READ_REDIS_CLUSTER_NODES` plus `READ_REDIS_NODE_ADDRESS_MAP` or
`READ_REDIS_URL`. Start the existing local Kafka and Redis stack first. Apply
`make projection-migrate` and register
`infra/kafka/connectors/projection-notifications-outbox.json` as connector
`projection-notifications` to enable CDC. This test publishes canonical
notifications directly; it does not exercise the transformer in the same run.

For the complete local path, run `make events-up` and `make redis-up`, then
`make cache-invalidator-up` to build and start the opt-in worker on both
networks. The worker exposes `/healthz`, `/readyz`, and `/metrics` on loopback
port 58091. `scripts/cache-projection-e2e.mjs` exercises a committed projection
change, Debezium, transformer, Kafka, invalidator, and the Read API cache. It
uses isolated consumer groups and requires the local Postgres and Redis URLs.

Projection version promotion emits one infrastructure-tenant `epoch`
notification in the same transaction as the read-view switch. This invalidates
all tenants without adding millions of rows to the promotion transaction.
The public-schema outbox trigger carries it through the same CDC and Kafka
path as ordinary projection notifications. A disposable promotion test proves
the two operations commit or roll back together.
