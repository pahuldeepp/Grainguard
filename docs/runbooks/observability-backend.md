# Runbook: observability backend degraded

**Severity:** ticket; page only if monitoring loss coincides with user/data risk.  
**Signals:** collector export failures/queue, Prometheus scrape/storage errors, Grafana/Loki/Tempo availability.

## Triage

1. Check collector health and export failures, then backend health and disk/retention pressure.
2. Determine whether telemetry is delayed, sampled, rejected, or unavailable; avoid inferring healthy service state from absent telemetry.
3. Protect application capacity: telemetry resource/queue limits must prevent telemetry from exhausting service resources.
4. Restore the backend or reduce telemetry volume through approved sampling/retention controls. Preserve error traces and critical service metrics where possible.
5. Verify new samples arrive, dashboards leave unknown state, and the monitor for observability degradation resolves.

## Recovery and evidence

Record gaps in telemetry coverage and any impact on incident detection. A telemetry outage that obscures a user incident must be included in the incident review.
