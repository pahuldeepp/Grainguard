# Unified Read API

The authenticated Read API selects the owning read store: PostgreSQL for
current/recent data and rollups, Cassandra for older raw telemetry, and
Elasticsearch for search. Tenant scope comes from the verified token, never a
request parameter. Redis caches derived responses with tenant-scoped keys and
short TTLs; cache failure falls back to the owner store.
Machine API keys and OAuth client-credentials tokens require the private
`CONTROL_PLANE_URL` and matching `CONTROL_LOOKUP_TOKEN`. The Read API asks the
control plane for the service principal's tenant and scopes on each machine
request and fails closed when verification is unavailable. Never expose the
lookup token to a browser or a public ingress.
For Redis Cluster, `READ_REDIS_CLUSTER_NODES` accepts comma-separated
`redis://` or `rediss://` URLs. All startup URLs must use the same TLS mode and
credentials. `/healthz` is liveness; `/readyz` checks Cassandra connectivity
and a bounded PostgreSQL query, and excludes optional Redis.

Cold Cassandra history and Elasticsearch search have independent per-process
bulkheads beneath the cache. Defaults are 32 history requests per instance and
4 per tenant, and 64 search requests per instance and 8 per tenant. Set
`READ_HISTORY_CONCURRENCY`, `READ_HISTORY_TENANT_CONCURRENCY`,
`READ_SEARCH_CONCURRENCY`, and `READ_SEARCH_TENANT_CONCURRENCY` to tune from
load measurements. Saturated requests return HTTP 503 `read_busy` with
`Retry-After: 1`; the slot is released even if the backend fails. This is a
concurrency ceiling, not a distributed request-rate quota.

Run `npm test -w @greenguard/read-api` for focused tests. The live database
test additionally needs `READ_API_LIVE=1` and running PostgreSQL, Cassandra,
and Elasticsearch. Stage 08 remains in progress until the browser, CI,
coverage and production deployment gates pass.
