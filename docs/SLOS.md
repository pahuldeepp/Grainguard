# Service level objectives (Stage 11)

**Status: PROPOSED for owner approval. Nothing in this document is approved, and every numeric target is UNMEASURED.** Stage 13 load, soak and fault data must exist before targets are approved. Rules: [`rules/slo.yaml`](../infra/observability/rules/slo.yaml). Tests: [`tests/slo.test.yaml`](../infra/observability/tests/slo.test.yaml). Dashboard: `greenguard-slo-burn`. Runbooks: [page](runbooks/slo-burn-page.md), [ticket](runbooks/slo-burn-ticket.md), [integrity](runbooks/slo-integrity.md).

Targets derive from the Tier 1 goals in `CAPACITY_MODEL.md`: API p95 under 300 ms, commit-to-projection p95 under 1 s, at least 99.9% availability, zero acknowledged-event loss. Window for all SLOs: **30 days rolling**. Error budget = 1 minus target.

The 30-day error-budget panel is withheld until Prometheus reports at least 30 days
of retained samples. `SLOHistoryWindowUnavailable` alerts while that evidence is
missing or shorter than the window; configured retention flags alone do not prove
that the TSDB size cap preserved 30 days.

## Journeys and SLIs

Every SLI is `bad events / total events` (recorded as `slo:error_ratio:rate<window>{sli=...}`); burn rate is that ratio divided by the budget (`slo:error_budget:ratio`). Only metrics that exist in the services today are used. Ratios are empty, not zero, when there is no traffic.

| Journey                                                | `sli`                   | Good / bad (metrics)                                                                                                                                                                            | Proposed target   | Budget |
| ------------------------------------------------------ | ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- | ------ |
| Ingest accepted                                        | `ingest_availability`   | good: 2xx, bad: 5xx on `http_server_requests_total{job="telemetry-ingest",route=~".*/readings"}`. 4xx and 429 are client outcomes (ADR-0007) and excluded; that exclusion needs owner approval. | 99.9%             | 0.1%   |
| API read availability                                  | `api_availability`      | bad: 5xx; total: non-4xx, on device-service and workflow-alerts, health and metrics routes excluded                                                                                             | 99.9%             | 0.1%   |
| API read latency                                       | `api_latency`           | good: `http_server_duration_seconds_bucket{le="0.25"}` over `_count`. 0.25 s is the nearest exposed bucket below the 300 ms p95 goal, so it is conservative.                                    | 95% within 250 ms | 5%     |
| Reading visible in read API within the freshness bound | `projection_freshness`  | good: `projection_event_to_projection_seconds_bucket{le="1"}` over `_count`                                                                                                                     | 95% within 1 s    | 5%     |
| Notification delivered                                 | `notification_delivery` | good: `notifications_outcome_sent_total`; bad: `failed`, `dead` and `notifications_unknown_parked_total`; suppressed excluded                                                                   | 99%               | 1%     |
| Alert-to-notification job dispatched                   | `job_dispatch`          | good: `jobs_dispatch_published_total`; bad: `jobs_dispatch_dead_total`; retries are not bad                                                                                                     | 99.9%             | 0.1%   |

Where the projection histogram measures event to projection, the commit-to-canonical part of the Tier 1 goal is not covered; see Missing instrumentation.

## Alerting (multi-window, multi-burn-rate)

Both windows must exceed the multiple. A long window alone (an incident that recovered) or a short window alone (a brief spike) does not alert; both cases are unit-tested.

| Alert                   | Windows    | Burn  | Severity | Budget consumed |
| ----------------------- | ---------- | ----- | -------- | --------------- |
| `SLOBurnRateFastPage`   | 1h and 5m  | 14.4x | page     | 2% per hour     |
| `SLOBurnRateSlowPage`   | 6h and 30m | 6x    | page     | 5% in 6h        |
| `SLOBurnRateFastTicket` | 24h and 2h | 3x    | ticket   | 10% in 24h      |
| `SLOBurnRateSlowTicket` | 3d and 6h  | 1x    | ticket   | 10% in 3d       |

Recorded windows: 5m, 30m, 1h, 2h, 6h, 1d, 3d, 30d. `slo:error_budget_remaining:ratio30d` is 1 minus the 30d ratio over the budget (negative means overspent). Labels are bounded to the fixed `sli` label; no tenant, device, saga or trace identifier appears.

## Non-SLO invariants (zero tolerance)

These are not percentages. A single violation is an incident, alerted by `Integrity*` rules (`slo_class: integrity`):

- **Accepted readings are never silently lost.** Reading, outbox row, receipt and audit commit in one transaction. No spending-a-budget interpretation applies.
- **Quarantined or dead events never vanish.** `IntegrityCDCQuarantined`, `IntegrityProjectionQuarantined`, `IntegrityJobsDLQPublishFailed`.
- Tenant isolation, idempotent replay and event ID stability are invariants, verified by tests, not SLOs.

## Missing instrumentation (no SLI exists yet; no rule invented)

| Journey                                                | Needed metric                                                                                                                                       |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Alert opened after risk crosses threshold              | risk-score-to-alert-open latency histogram and a count of threshold crossings without an alert (Stage 06 workers expose no such metric)             |
| Notification acknowledged                              | acknowledgement counter and time-to-acknowledge histogram                                                                                           |
| Provisioning saga completes                            | saga started, completed, compensated and failed counters with a duration histogram (Stage 07 exposes none)                                          |
| Commit-to-canonical latency                            | histogram in the CDC transformer from outbox commit time to canonical publish                                                                       |
| Ingest latency                                         | telemetry-ingest RED buckets exist but the p95 target is not adopted as an SLO until measured                                                       |
| Unpublished outbox age and accepted-vs-canonical count | reconciliation metric backing the zero-loss invariant (currently only proved in tests)                                                              |
| API availability across the gateway/BFF                | Stage 08 gateway and BFF metrics                                                                                                                    |
| SLI absence                                            | a blackbox or synthetic probe, so an SLI with no traffic is distinguishable from a broken scrape (`ObservabilityTargetDown` covers only the scrape) |

## Needs real load data before approval (Stage 13)

- Whether 99.9% and the latency goals are achievable at Tier 1 (100k users, 10k concurrent, 20k/50k events/s).
- The 0.25 s bucket proxy versus a true 300 ms p95, and the 1 s freshness bucket under load and replay.
- 4xx/429 exclusion policy, health and load-test traffic exclusion, and the notification provider mix (suppressed, unknown) in the denominator.
- Alert thresholds and noise levels from soak and fault injection; ticket versus page routing agreed with the owner.
- 30d rate recording cost on a real series count.
