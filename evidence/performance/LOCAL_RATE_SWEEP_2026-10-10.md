# Local authenticated telemetry-ingest rate sweep

Date: 2026-10-10<br>
Source revision: `1c6776d`<br>
Environment: local GreenGuard telemetry-ingest + PostgreSQL, synthetic tenant and devices<br>
Scope: authenticated HTTP ingest through the PostgreSQL transaction only.

This is an initial local rate sweep, **not** Stage 13 capacity certification. It
does not exercise Kafka, CDC, projections, Cassandra, alerts, multi-AZ failure,
AWS, or a distributed load generator. The local harness disables the binding-feed
freshness gate and simulates trusted proxy source addresses for admission control.
The 300/s run passes the harness's acceptance/drop thresholds, but its latency
tail exceeds 300 ms; the harness does not define an ingest-latency pass threshold.

| Offered rate | Duration | Accepted | Request rate | Acceptance | HTTP p95 | Dropped iterations | Result |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| 100/s | 30s | 3,001 | 99.96/s | 100% | 11.84 ms | 0 | Accepted |
| 200/s | 20s | 4,001 | 199.99/s | 100% | 12.71 ms | 0 | Accepted |
| 250/s | 30s | 7,501 | 249.87/s | 100% | 40.42 ms | 0 | Accepted |
| 300/s | 20s | 6,001 | 299.71/s | 100% | 367.05 ms | 0 | Latency degraded |
| 500/s | 20s | 8,160 | 480.51/s | 82.57% | 715.99 ms | 118 | Failed |

Per-run JSON evidence:

- `local-telemetry-ingest-local-mv2v22e6.json` (100/s)
- `local-telemetry-ingest-local-mv2v5y0g.json` (200/s)
- `local-telemetry-ingest-local-mv2v7mjg.json` (250/s)
- `local-telemetry-ingest-local-mv2v6lu2.json` (300/s)
- `local-telemetry-ingest-local-mv2v3131.json` (500/s)

Interpretation: this local host accepted 250/s for 30 seconds, while the 300/s
sample showed a large latency tail and the 500/s sample saturated. These short
runs are not a stable production capacity number or proof that PostgreSQL alone
is the bottleneck. They justify profiling and longer repeated tests before
choosing a batching change. The architecture's transformer/projection consumers
also have separate sequential-processing limits that this test does not measure.

Tier 1 targets remain unproven: 20,000/s sustained, 50,000/s peak, API p95 under
300 ms, telemetry commit-to-canonical and queryable-projection p95 under 1 second,
99.9% availability over 30 days, and zero acknowledged-event loss within the
certified failure domain.
