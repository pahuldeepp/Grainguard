# Runbook: SLO error-budget burn (page)

**Severity:** page. **Alerts:** `SLOBurnRateFastPage` (14.4x over 1h and 5m), `SLOBurnRateSlowPage` (6x over 6h and 30m).
**Owner:** the on-call engineer for the journey named in the `sli` label. Targets are PROPOSED; see [SLOs](../SLOS.md).
**Dashboard:** Grafana "GreenGuard - SLO Burn Rates (proposed)" (`greenguard-slo-burn`): panels "Burn rate 1h", "Burn rate 6h", "Error ratio 5m by SLI", "Error budget remaining".

## Symptom

The named SLI is consuming its 30 day error budget far faster than allowed. The fast alert means about 2% of the budget is spent per hour; the slow alert means the budget is gone in about 5 days.

## Diagnosis

1. Confirm both windows: `slo:burn_rate:1h{sli="<sli>"}` and `slo:burn_rate:5m{sli="<sli>"}` above 14.4 (or the 6h pair for the slow alert). If only one window is high the alert should not have fired; check for a rule or scrape gap.
2. Find the bad events by SLI:
   - `ingest_availability`: `sum by (status_code) (rate(http_server_requests_total{job="telemetry-ingest",route=~".*/readings"}[5m]))`, then [database saturation](database-saturation.md) and [API errors](api-errors.md).
   - `api_availability` and `api_latency`: `sum by (job, route, status_code) (rate(http_server_requests_total[5m]))` and `service:http_latency:p95_5m`; follow [API errors](api-errors.md).
   - `projection_freshness`: `projection_pending_records`, `projection_lag_records`, `cdc_commit_lag`; follow [projection freshness](projection-freshness.md) and [streaming backlog](streaming-backlog.md).
   - `notification_delivery`: `rate(notifications_outcome_failed_total[5m])`, `notifications_outcome_dead_total`, `notifications_unknown_parked_total`, `notifications_provider_in_flight`; follow [notification delivery](notification-delivery.md).
   - `job_dispatch`: `rate(jobs_dispatch_dead_total[5m])`, `jobs_dispatch_lag_seconds`; follow [streaming backlog](streaming-backlog.md).
3. Check recent deploys and configuration changes, then the traces for a failing request (trace ID from logs; never a metric label).

## Mitigation

Roll back the implicated release or restore dependency capacity. Do not silence the alert, widen a bucket, or exclude requests from the SLI to make the ratio look better.

## Escalation

Escalate to the service owner if not mitigated in 30 minutes, and to the incident lead if the 30 day budget remaining (`slo:error_budget_remaining:ratio30d`) drops below zero. Record the affected SLI, cause, mitigation and budget spent.

## Verification

Both windows fall below the threshold and the alert resolves; the 5m error ratio returns to baseline.
