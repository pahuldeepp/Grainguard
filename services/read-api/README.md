# Unified Read API

The authenticated Read API selects the owning read store: PostgreSQL for
current/recent data and rollups, Cassandra for older raw telemetry, and
Elasticsearch for search. Tenant scope comes from the verified token, never a
request parameter. Redis caches derived responses with tenant-scoped keys and
short TTLs; cache failure falls back to the owner store.

`READ_HISTORY_HOT_WINDOW` controls the PostgreSQL/Cassandra telemetry history
cutover (Go-style duration, default `24h`, range `1h`–`2160h`). Keep it exactly
aligned with projection maintenance's `PROJECTION_HISTORY_HOT_WINDOW`; the read
API advances the signed pagination cursor's boundary as retention progresses. Requests crossing the
boundary query both stores, merge by stable `reading_id` (PostgreSQL wins in the
overlap), then sort and paginate once. This is a bounded merge, not MapReduce.
Alert lifecycle transitions are a separate PostgreSQL-owned history and do not
move to Cassandra at 24 hours.

`READ_HISTORY_CURSOR_SECRET` is a required private HMAC key containing at least
32 bytes. Local bootstrap generates a dedicated value. All read replicas must
share the stable key; rotating it invalidates outstanding history cursors.
Database credentials, placement lookup tokens, and shard manifests are never
used as signing keys. Deployment preflight validates the key in `read-api-config`,
and the Read API chart references that Secret explicitly.
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

PostgreSQL reads share a fair per-tenant queue (32 active per process, four per
tenant; bounded queued work). In sharded mode, `READ_SHARD_POOL_MAX` sets the
maximum connections per endpoint, default five and valid from one to 32. With
four shards and one replica each, a pod can use up to eight times this setting.
Budget the total across autoscaled pods against PostgreSQL connection capacity.
Local pool saturation returns `read_busy` and does not mark an endpoint failed.

`GET /api/v1/read/devices/:deviceId/current` reads device and latest reading in
one SQL snapshot. Request-scoped placement leases are reused within that request;
final admission still fences the response against tenant moves. The original
read budget includes authentication and admission and is capped at four seconds.
See `docs/READ_ADMISSION_AUDIT.md` for guarantees and live-validation limits.

Run `npm test -w @greenguard/read-api` for focused tests. The live database
test additionally needs `READ_API_LIVE=1` and running PostgreSQL, Cassandra,
and Elasticsearch. Stage 08 remains in progress until the browser, CI,
coverage and production deployment gates pass.

Delegated `greenguard-mcp` callers with audience `read-api`, scope
`telemetry:read`, and a current verified tenant membership may use only exact
`GET /api/v1/read/devices/:deviceId/{latest,current,readings,rollups,risk}`
paths. The existing history and rollup bounds, entitlement check, origin
bulkheads, placement admission and response deadline also apply to these reads.

`GET /api/v1/read/devices/:deviceId/risk?from=...&to=...&limit=...` reads
historical assessments from the owning `read.risk_assessments` security-invoker
projection using the authenticated tenant transaction and explicit tenant filters.
Both bounds must be zoned timestamps, `from < to <= now`, at most 31 days apart
and within the tenant history entitlement. `limit` is 1–100 (default 100).
Other query fields are rejected. The interval is half-open and refers to
assessment `occurred_at` (event creation time), not telemetry observation time.

The response is `{ data, source: "postgres", from, to }`. `data` contains
`status` (`available`, `no_assessments`, or `device_not_found`), `assessments`,
`truncated`, `validity: "unverified"`, `actionable: false`, and a `caveat`.
A single SQL snapshot checks device ownership and reads at most `limit + 1`
assessment rows; responses above 256 KiB fail with `response_too_large`.
No assessment is generated when there is no stored row. Assessment and policy
versions are decimal strings. Assessments carry the stored policy calibration
and provenance, score, severity, reasons and source reading ID.

Risk invalidation events are retained in a durable tenant-scoped ledger, including
withdrawals received before an assessment. The fixed query excludes every named
assessment before ordering and limiting. Absence of a projected withdrawal does
not prove current validity, policy applicability or source freshness. These
historical rows cannot establish current risk even when an
assessment has `alert_eligible: true`. A limited page is not a complete-range
aggregate; `truncated` means more assessments exist in the requested interval.

Focused risk checks: after `npm run build -w @greenguard/read-api`, run
`node --test services/read-api/dist/device-risk.test.js`. For the local live
RLS acceptance, load the existing private environment and run with
`READ_RISK_LIVE=1 node --test services/read-api/dist/device-risk.live.test.js`.
It requires two already bootstrapped tenants and creates assessment/inbox/device
test fixtures only inside a transaction that always rolls back. It checks
`read_query` cannot bypass RLS, same-device tenant separation, foreign-device
absence, and RLS denial even when a query explicitly names the foreign tenant.
This proves read-side withdrawal filtering and ledger RLS; delivery acceptance
remains a separate consumer check.
