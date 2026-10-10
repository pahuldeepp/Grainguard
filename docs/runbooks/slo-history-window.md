# Runbook: Prometheus SLO history window unavailable

**Severity:** ticket. **Alert:** `SLOHistoryWindowUnavailable`.
The 30-day error-budget panel remains withheld until Prometheus can prove a complete
30-day sample window. The configured time retention is a ceiling, not proof that the
size limit or disk capacity preserved that much history.

## Symptom

The alert fires, and `slo:error_budget_remaining:ratio30d` is absent from Grafana.

## Diagnosis

1. Check Prometheus target `prometheus` is healthy and exposes
   `prometheus_tsdb_lowest_timestamp_seconds`.
2. Evaluate `time() - min(prometheus_tsdb_lowest_timestamp_seconds{job="prometheus"})`.
   The result must be at least `2592000` seconds before the 30-day budget is trusted.
3. Check the Prometheus PVC free space, TSDB block age, retention-size setting, and
   recent restarts. A configured `35d` retention time does not override the size cap.

## Mitigation

Restore the scrape and persistent-volume capacity. If the retention-size cap is
evicting blocks early, size the PVC and cap from observed series volume, then apply
the change through the reviewed GitOps/Terraform path. Do not silence the alert or
report a 30-day budget from a shorter sample window.

## Escalation

Escalate repeated data loss, PVC exhaustion, or retention below policy to the
platform owner. Record the oldest retained timestamp and the tested recovery action.

## Verification

Confirm the oldest timestamp is at least 30 days old, the alert resolves, and
`slo:error_budget_remaining:ratio30d` returns one series per configured SLI.
