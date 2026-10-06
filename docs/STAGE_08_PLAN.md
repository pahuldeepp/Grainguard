# Stage 08 — Gateway, GraphQL BFF and dashboard

Status: locally validated, remote CI pending. The final [33-check browser run](../evidence/stage08-e2e/report.md) passes provisioning, repair, reading-ID freshness, two-tenant reads, alerts, WebSocket reconnect, Redis read-cache outage/recovery, accessibility and Read API outage/recovery. The BFF has request-scoped device batching and a tenant-scoped reading-ID lookup. Storybook and the runtime images build locally. The [Stage 08-scoped Sonar gate](../evidence/STAGE_08_SONAR_VALIDATION.md) passes at 82.9% coverage, 0% duplication, 0 issues and 0 hotspots. The new mandatory Stage 08 GitHub Actions job has not run remotely; the shared full-repository gate also includes concurrent Stage 09 work. Stage 07's live provisioning gate must pass before Stage 08 is marked complete.

## Request flow

```text
React dashboard
  → authenticated GraphQL BFF
      → saga API: start/status/history/admin redrive
      → unified Read API: current/recent/rollups/search/history
           → read PostgreSQL: current/recent/rollups
           → Cassandra: raw long-term telemetry
           → Elasticsearch: device/site/bin/alert search
```

The BFF validates the user's RS256 token and role, forwards the bearer to the owning API, and never accepts a tenant ID from a GraphQL argument. The saga remains the command owner. The Read API selects a store by query type; neither React nor the BFF queries a database directly.

## Delivery slices

1. **Provisioning adapter.** Typed GraphQL start/status/redrive operations, persisted-operation IDs, opaque tenant-scoped errors, idempotency-key forwarding and RBAC are implemented. The local browser run proves start, reconnect, repair and cross-tenant denial through the gateway.
2. **Unified read composition.** Device, site-device, alert, current, reading-ID, hot-history and rollup queries are available; long-range raw history routes to Cassandra and search to Elasticsearch. The BFF batches device lookups per request with tenant-scoped keys. The first Redis cache-aside adapter uses tenant-scoped keys, short jittered TTLs, `SET NX PX` locks, double-checks, and token-checked Lua fill/unlock. Production uses `READ_REDIS_CLUSTER_NODES`; local development can use `READ_REDIS_URL`. Cache failure falls back to the owner store. A lock wait timeout also falls back to the owner, so the lock reduces stampedes rather than guaranteeing a single backend request under prolonged contention. Per [ADR-0015](adr/0015-read-cache-and-locks.md) (Proposed) the adapter uses ioredis in cluster mode, versioned `gg:read:v1:{t:<tenant>}` keys with a checked tenant envelope, 50 ms command timeouts with a breaker, a 256 KiB value cap, NX fills for expired lock holders and tenant generation keys for invalidation. Projection invalidation publishes live hints to Redis after committed version changes. Local live chaos and load evidence is in [STAGE_08_REDIS_VALIDATION.md](../evidence/STAGE_08_REDIS_VALIDATION.md); it does not prove the 10-million-user target.
3. **GraphQL safety.** Persisted operation allowlist and depth/complexity budgets are implemented. The BFF now has a Redis-backed atomic token bucket with both tenant and user budgets, separate mutation budgets, query-specific costs, `429` and `Retry-After`; configure `BFF_RATE_REDIS_CLUSTER_NODES` in production or `BFF_RATE_REDIS_URL` for a local Redis node. The limiter fails closed with `503` if configured Redis becomes unavailable. The Read API now has separate Cassandra and Elasticsearch origin bulkheads, each with per-process and per-tenant concurrent limits; saturation returns `503` plus `Retry-After`. Distributed direct-caller quotas, CSRF protection on browser mutations, and load-tuned budgets remain open. Never expose unrestricted introspection or arbitrary backend URLs in production.
4. **Dashboard.** OIDC login, provisioning/repair, device search/current/history/rollups, alerts and acknowledgement views are implemented. The current view refetches the durable read model after WebSocket reconnect and polls as a fallback. A reading-ID query shows pending projection and later processed time without mislabeling an older observation as the latest reading. Subscriptions are hints, not the source of truth.
5. **Gate.** The local two-tenant browser run, focused API/UI tests, Stage 08-scoped coverage/Sonar, and CodeRabbit review pass. The browser Redis-outage case exercises the Read API cache and subscription fallback with BFF rate limiting disabled in the harness; production quota Redis outage remains fail-closed. The first GitHub Actions run of the new `stage08-integration` job and a green whole-repository gate after Stage 09 settles remain required. Record remote evidence before marking Stage 08 complete.

Scale work follows the master plan's cell placement, cache invalidation, pagination, per-service budgets and load profiles; this initial adapter does not establish the 10-million-concurrent-user target.
