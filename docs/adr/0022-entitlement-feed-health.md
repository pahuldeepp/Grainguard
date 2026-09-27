# ADR-0022: Entitlement freshness is feed health, not plan age

Status: Accepted for Stage 09c (2026-09-25). Amends the freshness sentence of [ADR-0018 quotas](0018-quotas-and-overage.md).

Defect: ADR-0018 treated a projected entitlement as valid only if `applied_at` was within five minutes. `applied_at` changes only when a NEWER `source_version` arrives and `entitlements.changed` is emitted only on a subscription change, so every paid tenant fell back to free limits five minutes after its last plan change (ingest 429, seat, key and device limits, history range).

Decision. Two separate facts:

1. `applied_at` stays "when this plan version was applied". It is never used for freshness.
2. Feed health is a per-partition heartbeat. Each consuming database has `entitlement_feed_health(partition_id, verified_at)` and a `SECURITY DEFINER STABLE` function `entitlement_feed_fresh(max_age default 5 minutes)` that is true only when at least one partition row exists and the OLDEST `verified_at` is within the bound. Every consumer (telemetry-ingest, device-service, control plane, Read API) replaces `applied_at >= now() - 5 minutes` with that function, so there is one definition per database and no per-service arithmetic. `EntitlementStore` in `packages/entitlements` implements the same rule in memory.

Consumers fail closed to the free defaults ONLY when the feed is stale or has never reported; an unchanged paid plan is honored indefinitely while the feed is healthy. A plan change still takes effect immediately (the projector applies it on arrival).

Heartbeat producer. `packages/entitlements/src/heartbeat.ts` (`npm run heartbeat -w @greenguard/entitlements`) sends `entitlements.heartbeat` `{emitted_at}` to EVERY partition of `greenguard.billing.lifecycle.v1` every 60 s with up to 10% jitter. A consumer proves it has caught up on a partition only by reaching that partition's own heartbeat, so a lagging partition keeps the feed stale. The projector stores `LEAST(emitted_at, clock_timestamp())` with `GREATEST` against the stored value (monotonic: a late or replayed heartbeat never lowers health and a skewed producer clock cannot run ahead of the database). A malformed heartbeat goes to the DLQ like any poison event.

Why not per-tenant republish or per-row `verified_at`. A per-row refresh needs one message and one write per tenant every interval (10M tenants means about 167k events/s just to stay fresh) and the projector cannot update all rows anyway: the tables have forced RLS and the projector has no cross-tenant context. The heartbeat costs O(partitions) per interval regardless of tenant count, touches no tenant row, and cannot cross tenants.

Data model. The health table has no tenant column and holds no tenant data. It still has forced RLS with one permissive policy (repo invariant: every table forced), the projector role is the only writer, there is no DELETE grant, and the row count is bounded by the partition count. Concurrency is optimistic and monotonic (upsert with `GREATEST`). Migrations are forward-only. Migration comments written before this ADR was numbered cite "ADR-0020"; they mean this ADR.

Operational. The heartbeat job is a singleton-safe extra process (running two only doubles a trivial load). Alert when `min(verified_at)` age exceeds 3 minutes. Kafka or projector outage stops heartbeats, so limits fall back to free after at most five minutes: this is the deliberate fail-closed bound. Until the first heartbeat after deploy, consumers use free defaults.

Also fixed under this item. The billing catalog now defines every limit key for every plan, including `exports.per_day`, `retention.days` and ingest rates; rates are integer readings per minute because entitlement limits must be integers (the free 0.2 per second default became 12 per minute).
