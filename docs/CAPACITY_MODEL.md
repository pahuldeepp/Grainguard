# Capacity tiers and reproducible arithmetic

**All sizing is UNMEASURED.** Tier 1 is the FIRST CERTIFIED TIER target, to be
certified by Stage 13; it is not a claim about the current implementation. Tier U
retains the ultimate 10M accounts / 10M organizations / 10M concurrent users goal
and requires Stages 12–14 cell and fleet evidence, including G8.

## Targets and reconciliation

| Dimension                 | Tier 1: Stage 13 target                                                            | Tier U: existing model retained                                | Conflict / governing rule                                                                                                   |
| ------------------------- | ---------------------------------------------------------------------------------- | -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Registered users          | 100,000                                                                            | 10,000,000                                                     | Separate certification envelopes                                                                                            |
| Concurrent active users   | 10,000                                                                             | 10,000,000                                                     | Joint API/session traffic, not idle sockets                                                                                 |
| Organizations             | 10,000 assumed in one cell                                                         | 10,000,000; 100,000 per illustrative cell                      | Tier 1 placement assumption requires owner confirmation                                                                     |
| Connected devices/sensors | 1,000,000                                                                          | 100,000,000 (10 per tenant)                                    | Tier 1 assumes 100 per tenant; test skew                                                                                    |
| Normal telemetry          | 20,000 events/s                                                                    | 1,666,667 events/s fleet; 16,667 per million devices           | Tier 1 = 0.02/device/s, one per 50s; legacy = 1/60s; Tier 1 is 20% higher per device                                        |
| Peak telemetry            | 50,000 events/s, 2.5× normal                                                       | 5× normal; 83,333 per million, 8,333,333 fleet                 | Tier 1's 50k governs its burst; legacy 5× remains Tier U                                                                    |
| Typical encoded event     | ≤2 KB (2,000 bytes)                                                                | 1 KiB (1,024 bytes)                                            | Benchmark Tier 1 at 2,000 bytes including JSON envelope; separately record Kafka headers/keys; do not substitute binary KiB |
| API latency               | p95 <300 ms                                                                        | p95 <500 ms, p99 <1s                                           | Tier 1 is stricter; edge arrival to response, per critical endpoint                                                         |
| Telemetry processing      | p95 <1s, ingest commit to both canonical-topic visibility and queryable projection | p95 <2s, p99 <5s, accepted reading to projection/alert         | Different boundaries; Tier 1 measures both legs and their maximum, alerts certified separately in Stage 06                  |
| Availability              | ≥99.9% over 30 days                                                                | Candidate ≥99.95% over 30 days                                 | Tier 1 does not lower Tier U's proposed SLO                                                                                 |
| Acknowledged-event loss   | Zero within certified component/AZ failure domain                                  | Zero within synchronous domain; regional RPO ≤5min, RTO ≤30min | Regional asynchronous loss allowance cannot satisfy an unqualified zero-loss promise                                        |

**Placement/failure-domain assumption to confirm:** Tier 1 is one independently
operated cell serving 10,000 organizations across three AZs in one region, surviving
one component or one AZ loss. Use synchronous database durability and Kafka
RF3/minISR2 with all-ISR acknowledgements; actually prove durability under failures.
Total region destruction is outside Tier 1 certification. If zero loss must include
regional destruction, redesign cross-region acknowledgement durability and recertify;
the existing five-minute regional RPO cannot be relabeled zero. Local RF1 is ineligible.

The legacy top-level JSON keys remain unchanged and govern Tier U arithmetic;
`tiers.tier_1` adds independent inputs and `tiers.tier_u` states scope and SLOs.
The legacy generator ignores the new keys. Run an unchanged copy of
`scripts/capacity_model.py` with the input in an isolated directory to reproduce the
legacy section: its current writer replaces CAPACITY_MODEL.md and also writes
CAPACITY_MODEL.json. Do not run it over this curated document without preserving
these tier sections. No generator change is required by `make check-plan`.

## Tier 1 pipeline sizing walk-through — UNMEASURED

These are first-order budgets, not hardware throughput measurements or deployable
replica recommendations. Normal/peak rates are simultaneous with 10k active users:
reuse 0.2 API requests/user/s = 2,000 API RPS, plus a 2× API burst = 4,000 RPS,
10,000 sockets and 1,000 delivered updates/s. Telemetry HTTP traffic is additional.

| Pipeline stage       | Normal 20k/s / peak 50k/s estimate                                                                                                                | Limitation to measure in Stage 13                                                                                                                                                                                                                                                                                          |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Payload transport    | 40 / 100 MB/s; 3.456 TB/day at normal rate                                                                                                        | Before headers, raw envelopes, indexes, replication or compression; raw and canonical are separate copies                                                                                                                                                                                                                  |
| Ingest replicas      | Assume 2,500 events/s/replica at saturation, operate at 70%: ceil(rate/1,750) = 12 / 29                                                           | Prove this assumption with real atomic transactions; 45 replicas evenly across 3 AZs leave 30 after losing one AZ, nominally 52,500/s; DB may invalidate this arithmetic                                                                                                                                                   |
| Postgres commit path | One transaction/event; reading + outbox + receipt + audit = 80k / 200k row inserts/s                                                              | [Review R3](ARCHITECTURE_REVIEW.md) warns of JSONB audit amplification. Four rows is not a WAL-byte multiplier. Measure WAL bytes/event, index IO, fsync, replication and CDC; JSON stores leave WAL/index factor null until measured. Audit reduction is a proposed follow-up, not assumed implemented                    |
| Raw outbox / CDC     | One telemetry raw partition carries all 20k / 50k events/s; inventory has its own single raw partition                                            | One active group worker per raw partition; adding canonical partitions or transformer pods does not split this bottleneck. Envelope bytes exceed canonical payload; preserve source/barrier order when redesigning                                                                                                         |
| Transformer          | ADR-0008: one outstanding record per process across assigned partitions. Example 5ms validate/publish/commit cycle gives only 200 events/s/worker | Ideal demand ceil(rate × 0.005) = 100 / 250 workers, but only ONE can own the telemetry raw partition. Required serial cycle ≤50 / 20 microseconds is an unproven requirement. Two replicas can split two raw topics, not one hot telemetry topic; batching/partition-aware concurrency needs a separately reviewed design |
| Canonical Kafka      | Six telemetry partitions average 3,333 / 8,333 events/s each; RF3 payload copies 120 / 300 MB/s                                                   | Assumes even keys; hot-device skew, broker IO, headers, raw topics and internal topics add load                                                                                                                                                                                                                            |
| Consumer groups      | At most six active partition consumers per six-partition topic per group; each must sustain ≥3,333 / 8,333 events/s                               | Groups for projection/history/search run independently and each reads the full stream. For example 5k/s/worker ×70% ×6 = 21k/s: normal barely fits, peak fails; extra replicas idle without more partitions or safe internal concurrency                                                                                   |
| CQRS read database   | Assume one inbox insert + one projection update/event = 40k / 100k row effects/s                                                                  | Atomic inbox/effect, tenant filters, version contention and rollups increase cost; cannot assume every event changes just one projection                                                                                                                                                                                   |
| Cassandra history    | Assume one logical history write/event = 20k / 50k writes/s; RF3 = 60k / 150k replica writes/s                                                    | Before separate dedupe/checkpoint, rollups, repair, compaction and late-arrival work; measure schema-specific amplification                                                                                                                                                                                                |

A 30-minute peak creates 54 million excess events if downstream only handles 20k/s:
(50k−20k)×1,800. That is at least 108 GB canonical payload at 2 KB/event and fails
the <1s freshness target. Buffering alone cannot certify Tier 1. Replay drain must
exceed ongoing arrival rate; measure backlog slopes and retention headroom, including
raw-offset loss and retained WAL. The present sequential topology is not certified
for either Tier 1 rate.

## Stage 13 certification protocol and evidence

All evidence names below are **planned files**, not existing results. Use distributed
k6 with open-loop telemetry arrival rates, separate session/API scenarios and enough
generator headroom. A harness must inspect DB commit timestamps, Kafka visibility,
projection state and failure injection; HTTP timings alone cannot measure CDC.
Record seed, commit, image/config digests, hardware, quotas, clock error, workload
mix, dropped iterations, offered/accepted rates, latency histograms and replay IDs in
`evidence/STAGE_13_TIER_1_MANIFEST.md`. Synchronize clocks and report error bounds
small enough to distinguish a 1s threshold; never infer commit time from HTTP ACK.

| Metric                          | Tool / duration                                                                                                                                                | Pass criterion                                                                                                                                                                                                   | Planned evidence under evidence/  |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| Users, organizations, devices   | k6 + fixture census; preload 100k users/10k organizations/1M devices; verify throughout 24h soak                                                               | Exact seeded counts; every device participates each normal 50s reporting cycle, 10k active sessions with 2k API RPS; tenant skew and cross-tenant denial tested                                                  | STAGE_13_TIER_1_POPULATION.json   |
| Normal telemetry                | k6 constant arrival; 30min warmup then 24h measured soak at 20k/s                                                                                              | Sustain offered and committed 20k/s, no dropped generator iterations or sustained backlog/resource growth; report retries separately                                                                             | STAGE_13_TIER_1_SOAK.json         |
| Peak telemetry                  | k6; three 30min 50k/s bursts, 30min normal between, with 4k API RPS                                                                                            | Sustain 50k/s during each burst while API/pipeline thresholds hold; lag returns to baseline within each 30min recovery interval                                                                                  | STAGE_13_TIER_1_PEAK.json         |
| Event bytes                     | k6 fixtures + capture audit throughout soak/bursts                                                                                                             | Valid canonical JSON fixtures up to and including 2,000 bytes; record size histogram; headers excluded and budgeted separately; larger supported events tested separately                                        | STAGE_13_TIER_1_PAYLOAD.json      |
| API latency                     | k6 regional probes throughout soak/bursts and 2h fault run                                                                                                     | p95 <300ms per critical endpoint in each phase and 5min window, including auth/cache misses; timeouts/errors count as failures                                                                                   | STAGE_13_TIER_1_LATENCY.json      |
| Commit → canonical → projection | k6 + timestamp/correlation harness throughout same phases                                                                                                      | p95 of max(canonical-visible, projection-queryable) minus ingest commit <1s, per phase and 5min window; also report both legs; missing observations fail                                                         | STAGE_13_TIER_1_PIPELINE.json     |
| Availability                    | k6 continuous representative probes plus offered-traffic SLIs; 30 consecutive days including soak/fault tests                                                  | API and ingest each ≥99.9%; valid 429/5xx/timeouts count unavailable, no exclusion of fault windows; 24h alone cannot certify a 30-day SLO                                                                       | STAGE_13_TIER_1_AVAILABILITY.json |
| Zero acknowledged-event loss    | k6 + durable ACK ledger/reconciliation; 2h normal-load fault campaign, inject process, connector, broker, DB failover and one-AZ loss; allow 30min final drain | Exactly zero ACK IDs absent from durable readings, canonical delivery ledger and projection-effect ledger after drain; retries deduped, no duplicate effects; latest-state overwrites verified via effect ledger | STAGE_13_TIER_1_DURABILITY.json   |

Archive raw outputs and summarize every threshold in
`evidence/STAGE_13_TIER_1_CERTIFICATION.md`; missing evidence means UNMEASURED, not
pass. Availability excludes neither planned fault windows nor binding-staleness
admission failures. Tier U needs separate `evidence/STAGE_12_CELL_TOPOLOGY.md`,
`evidence/STAGE_13_TIER_U_FLEET.md` and `evidence/STAGE_14_TIER_U_RECOVERY.md`,
covering G3–G8 and the simultaneous 10M/10M/10M workload. Scaling Tier 1 by
multiplication is a forecast, never Tier U certification.

## Legacy Tier U arithmetic (unchanged inputs)

arithmetic forecast only; excludes unmeasured storage/network/device-count/skew/replay bottlenecks.

Inputs: [capacity_assumptions.json](capacity_assumptions.json). Method: [capacity_model.py](../scripts/capacity_model.py). Context: [scale and production readiness](SCALE_AND_PRODUCTION_READINESS.md).

| Quantity                                          |  Calculated value |
| ------------------------------------------------- | ----------------: |
| api_rps                                           |     2,000,000.000 |
| device_count                                      |   100,000,000.000 |
| telemetry_eps                                     |     1,666,666.667 |
| telemetry_payload_bytes_per_second                | 1,706,666,666.667 |
| logical_event_payload_TB_per_day                  |           147.456 |
| replicated_kafka_payload_TB_for_retention         |         3,096.576 |
| concurrent_websockets                             |    10,000,000.000 |
| delivered_push_messages_per_second                |     1,000,000.000 |
| push_payload_bytes_per_second                     | 1,024,000,000.000 |
| refresh_requests_per_second_if_evenly_distributed |        11,111.111 |

## baseline_cell_forecast

```json
{
  "dimension_lower_bounds": {
    "api": 100,
    "telemetry": 84,
    "sessions": 100,
    "tenants": 100
  },
  "required_cells_lower_bound": 100,
  "provisioned_cells_with_region_reserve_lower_bound": 150
}
```

## burst_cell_forecast

```json
{
  "dimension_lower_bounds": {
    "api": 200,
    "telemetry": 417,
    "sessions": 100,
    "tenants": 100
  },
  "required_cells_lower_bound": 417,
  "provisioned_cells_with_region_reserve_lower_bound": 626
}
```

Cell values are unverified targets. These calculations are lower bounds and not a deployment recommendation, hardware benchmark, provider quota approval or production readiness certificate.
