# ADR-0007: ingest rate limiting with token buckets

Status: accepted, 2026-09-24 (Stage 03b design; the Redis-backed shared layer is Stage 08 and 13). Implements requirement X11.

**Algorithm.** A token bucket per device and a second one per tenant. It fits sensors: a steady rate, with a bounded burst for a device that reconnects and uploads a backlog, and it stops a broken or compromised device from flooding the API. Rates follow the device class (the capacity model assumes about one reading per minute per device); the initial burst allowance is about 20 readings, and the tenant limit sits above the sum of its devices' expected rates.

**Order on the ingest path.** Authenticate, then rate limit, then parse and validate the body, then the ingest transaction. The limiter needs the verified device and tenant to pick a bucket, and it must run before body parsing and any database work. A cheap pre-authentication limit per connection or IP belongs to the edge (WAF and gateway), because verifying a token is itself work.

**Response.** A limited request gets `429` with `Retry-After` and reason `rate_limited`. It is counted (`ingest_rejections_total{reason="rate_limited"}`) but never written to the rejection samples, so throttling cannot cause writes. Nothing is lost: the device retries with the same `source_message_id`, and idempotency makes the retry safe.

**Where the state lives.**

- Now: in-memory buckets behind a small `Limiter` interface. Memory is bounded: a bucket that has refilled to full is reclaimed first, and a bucket that still remembers a limit is never dropped. When the set is full of such buckets a new key is refused with `429` instead, so memory pressure can never reset a throttled device. Rates and sizes that could not work (a zero rate, a burst below 1, a zero size) fall back to the defaults.
- Per device, buckets stay local: a device's traffic is routed to the same pod by consistent hashing at the gateway, or the limit is divided by the pod count. A Redis round trip per reading would dominate at the planned 1.67 million readings per second.
- Per tenant, counters are shared approximately across pods through Redis per cell, using leases or periodic sync, not one call per reading.
- If Redis is unavailable, the local buckets keep consumption bounded (X11 requires this) and the condition is alerted.

**Tests required.** Steady rate passes; a burst up to capacity passes and the next request is limited; refill over time; per-device isolation (one noisy device does not throttle another); the tenant limit throttles a tenant across its devices; `Retry-After` is correct; concurrent requests obey the limit atomically; a limited request writes no rows.
