# ADR-0015: Read API cache and single-flight locks on Redis Cluster

Status: Proposed (2026-09-24). Owner approval pending.

## Context

Stage 08 puts a cache-aside layer in front of the Read API's owning stores (read Postgres, Cassandra, Elasticsearch). The old GrainGuard/CarePulse caches used unscoped keys. [PLATFORM_CONTRACTS_AND_OPERATIONS.md](../PLATFORM_CONTRACTS_AND_OPERATIONS.md) requires tenant-scoped keys. The cache must never become a correctness or availability dependency.

## Decision

1. **Client.** `ioredis` 6.0.0 in cluster mode (`services/read-api/src/redis.ts`). The first adapter used node-redis 5.1.1. That client only refreshes its slot map on `MOVED`/`ASK`, so after a primary was killed it kept sending that slot's commands to the dead node. Live result: 0 hits and 100% fallback after failover. ioredis refreshes on connection loss, and we also set a 1 s `slotsRefreshInterval`. The offline queue is off and `maxRetriesPerRequest` is 0, so an outage fails fast instead of queueing. `connect()` pings every node so the first burst does not time out on lazy connections. `READ_REDIS_NODE_ADDRESS_MAP` maps announced hostnames to reachable addresses (the ioredis `natMap`).
2. **Keys.** The format is `gg:read:v1:{t:<tenantId>}:g<generation>:<sha256(kind,args)>`, plus `:lock` for the lock and `gg:read:v1:{t:<tenantId>}:gen` for the generation.
   - `v1` is the envelope/key version. Bump it on any format change so old entries age out.
   - The hash tag `{t:<tenant>}` puts all of a tenant's keys, its lock and its generation in one slot. The Lua fill, unlock and invalidation scripts are therefore single-slot and atomic.
   - A tenant ID that does not match `^[A-Za-z0-9_-]{1,64}$` bypasses the cache. It can never inject `}`/`{` into the tag.
   - The stored envelope `{t, k, v}` is checked on every read. An entry whose tenant or digest differs from the request is treated as a miss (`mismatch` metric). A crafted or colliding write therefore cannot be served to another tenant.
3. **Slot-skew risk.** A hot tenant pins its whole cache load to one primary. That is acceptable at Tier 1 because the Read API's per-tenant budgets bound one tenant's rate. If Stage 13 measures a hot slot, shard the tag as `{t:<tenant>:<n>}` with n = hash(key) mod N. That spreads the load but makes generation bumps N writes.
4. **Limits.**
   - TTL: 15 s + 0–20% jitter.
   - Value size: at most 256 KiB serialized. Larger values are served but not cached (`oversize`).
   - Per-command timeout: 50 ms.
   - Circuit breaker: 5 consecutive failures bypass the cache for 1 s.
   - Nodes: `maxmemory` with `allkeys-lru`. Eviction only causes misses.
5. **Single-flight lock.** Acquisition is `SET lock token NX PX 2000` with a random UUID token. After acquiring, the holder double-checks the cache, loads, then fills with a Lua script:
   - if the lock still holds our token, `SET value PX ttl`;
   - otherwise (the lock expired mid-load) `SET value PX ttl NX`, so the fill never overwrites a newer one.

   Unlock is a Lua compare-and-delete. Waiters poll every ≤20 ms for up to 250 ms, then load without the lock (`lock_wait_timeout`). The first design rejected fills from an expired holder outright. Live, a loader slower than the lock TTL then made all 20 of 20 waiters load. With the NX fill it is 3 loads for a 300 ms loader and a 100 ms lock.
6. **Why not Redlock.** The lock is an efficiency hint, never a correctness guard. Every value is a read-only projection of the owning store and is bounded by TTL. A lost or duplicated lock only causes a bounded duplicate origin load. Fencing tokens protect the fill only against overwriting a newer fill, and the generation key protects against stale data after invalidation. Multi-node quorum locking would add latency and failure modes and protect nothing.
7. **Invalidation.** Tenant-scoped version stamps. `invalidateTenant(t)` runs `INCR` on the tenant's generation key, which lives in the same slot as its data. Readers read the generation first and build the key from it. Old-generation entries are never read again and age out by TTL. A loader that started before an invalidation fills an old-generation key that nobody reads, so a load racing an invalidation cannot resurrect stale data.
   - **Staleness bound without explicit invalidation:** TTL × 1.2 (18 s at the default; 600 ms measured bound in the live test with TTL 500 ms).
   - **With invalidation:** the next read after the `INCR` completes.
   - The cost is one extra `GET` per request.
   - Invalidation touches only that tenant's key. Other tenants' generations and entries are unchanged (tested).
8. **Failure policy.** A Redis error, timeout or open breaker serves from the owning store. The cache never returns an error to the client. Origin errors are not cached.
9. **Metrics.** `greenguard_read_cache_events_total{event}` exposes `hit`, `miss`, `load`, `fill`, `fill_rejected`, `timeout`, `error`, `fallback`, `bypass`, `lock_acquired`, `lock_wait_timeout`, `oversize`, `mismatch` and `invalidation` at `/metrics/cache`. There are no tenant labels.

## Consequences and open work

- **Who calls `invalidateTenant` is open.** The projection builder should bump the generation after its read-model commit, for example through a Kafka invalidation consumer in the Read API. That wiring is not built. Until it is, freshness is bounded by TTL only.
- `/metrics/cache` is unauthenticated on the Read API port. Move it to the shared metrics endpoint in Stage 11.
- Local compose uses static IPs. Redis stores peer IPs in `nodes.conf`, and after a full restart without static IPs the cluster kept stale addresses (one primary `noaddr`, one replica pointing at itself).
- Not measured: multi-host latency, TLS/ACL, Tier 1 load, and hot-tenant slot skew.
