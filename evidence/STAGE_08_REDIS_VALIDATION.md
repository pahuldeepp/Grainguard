# Stage 08: Read API Redis Cluster cache validation

Date: 2026-09-24. Checkout: uncommitted working tree on `main`. Design: [ADR-0015](../docs/adr/0015-read-cache-and-locks.md) (Proposed).

This is local, single-machine evidence (Docker Desktop, 7.7 GB). It is **not** Tier 1 certification, and it does not mark Stage 08 complete.

## Environment

- `infra/redis/compose.yaml` runs a Redis Cluster: 3 primaries and 3 replicas.
- Image: `redis:7.4-alpine@sha256:858f009f9709ce576febc734aa78b8f6d624b82571f9ddb6bda4377c833b3499`, digest from `docker buildx imagetools inspect`.
- Each node: 32 MB `maxmemory`, `allkeys-lru`, 64 MB container limit.
- Nodes use static IPs and are bound to `127.0.0.1:7101-7106`.
- Commands: `make redis-up`, `make redis-test`, `make redis-load`. None of them are in `make verify`.

## Live scenarios (`make redis-test`, exit 0)

Full output: [STAGE_08_REDIS_TEST.log](STAGE_08_REDIS_TEST.log).

| Scenario | Result |
| --- | --- |
| Two-tenant isolation | Tenant A hits its own entry. A tenant-A envelope planted under tenant B's key is rejected (`mismatch`) and B gets B's origin value. Invalidating A leaves B's generation `null`. |
| 200 concurrent cold requests | 1 backend load, all 200 values identical, 138 ms, 0 lock-wait timeouts. |
| Lock expiry mid-load (300 ms loader, 100 ms lock) | 3 backend loads (bound 4), 1 fill, 2 NX fills declined. The cached value is version 1, and no newer fill is overwritten. |
| Write then read | Without invalidation, stale data was served for 523 ms against a 600 ms bound (TTL 500 ms × 1.2). After `invalidateTenant`, the next read returned the new value. Initial PTTL was 503 ms. |
| Eviction under maxmemory | 240 MB written into 6 × 32 MB: 965 keys evicted, 0 wrong values, ~31 MB used per node. |
| Primary kill | 28,755 requests, 0 failed, max 51 ms. 40 Redis timeouts fell back to the origin. Cluster state was ok after promotion. The killed node rejoined with a healthy topology, and the next 2 s gave 6,027 hits with 0 fallbacks. |
| `docker pause` of a primary for 4 s | 20,899 requests, 0 failed, max 51 ms, 60 timeouts that fell back. |
| Full cluster restart | 39,945 requests, 0 failed, max 27 ms, 20 errors that fell back. The topology was healthy afterwards, and the hit ratio after restart was 0.991. |

## Load (`make redis-load`, exit 0)

Full output: [STAGE_08_REDIS_LOAD.log](STAGE_08_REDIS_LOAD.log).

Setup:

- 50 concurrent HTTP clients, 20 s per phase.
- 80% of requests go to 20 hot devices; the other 20% go across 400 devices × 2 tenants.
- Routes: `/devices/:id` and `/devices/:id/latest` against real read-Postgres with RLS.
- The Read API runs in its own worker thread. Auth is stubbed.

| Phase | rps | p50 ms | p95 ms | p99 ms | errors | hit ratio |
| --- | --- | --- | --- | --- | --- | --- |
| No cache (Postgres only) | 2,761 | 16.97 | 25.68 | 38.25 | 0 | – |
| Cache, warm | 14,786 | 3.02 | 5.63 | 11.08 | 0 | 0.989 |
| Cache, primary killed at +5 s | 11,086 | 3.26 | 15.09 | 20.08 | 0 | 0.991 |

During the kill phase, 251 timeouts and 42 errors fell back to Postgres. The breaker bypassed the cache for 15,213 requests. None of the requests failed.

## Bugs found and fixed

1. **node-redis never repaired its slot map after a failover.** It had 0 hits and 100% fallback after the kill. The Read API now uses ioredis with slot refresh.
2. **An expired lock holder's fill was always rejected.** A slow loader caused 20 of 20 waiters to load. The expired holder now fills with NX.
3. **Cold start.** The first burst hit lazy per-node connections. 19 of 20 requests timed out and each loaded the origin. `connect()` now pings every node before serving.
4. **Compose IP reuse after a full restart** left stale peers: one primary `noaddr`, one replica pointing at itself. The network now uses static IPs, and the restart and kill tests assert a healthy topology.
5. **No per-command timeout or offline-queue bound.** Both are added.

## Unit tests

- `npm test -w @greenguard/read-api`: 14 pass, 1 skipped (the existing live backend test).
- Cache module coverage (c8): 100% lines and statements; branches 94.7% for `cache.js` and 96.4% for `redis.js`.

## Not verified

- **Invalidation wiring:** no projection or Kafka producer calls `invalidateTenant` yet, so freshness is bounded by TTL only.
- **Environment gaps:** no multi-host network, TLS/ACL, or real network partition beyond `docker pause`.
- **Load gaps:** no hot-tenant slot-skew measurement, and no load on the Cassandra or search routes.
- **CI and Sonar:** remote CI and a Sonar run have not been done.
