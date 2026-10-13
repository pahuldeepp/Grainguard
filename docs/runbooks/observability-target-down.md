# Runbook: observability target down

**Severity:** ticket unless a user journey is degraded; page when paired with an SLO symptom.  
**Owner:** service owner for the target; platform operations owns scrape configuration.  
**Signals:** Prometheus `up == 0`, missing signal alert, dashboard shows unknown.

## Triage

1. Confirm the selected environment and target labels in Prometheus. A stopped optional profile is expected; do not treat it as healthy or as a production incident.
2. Check `/healthz` and `/readyz` from the Prometheus network namespace. Liveness may pass while readiness fails on a dependency.
3. Check service/container state and logs. Look for scrape path, port, DNS, TLS/auth, and timeout errors.
4. Compare the service's own health with its downstream DB/broker targets and the user-journey SLI. Escalate severity when user impact or data risk is present.
5. Restore the service or correct only the target configuration. Avoid increasing scrape timeout as a substitute for a failing service.
6. Verify `up == 1`, the expected metrics have fresh samples, dashboards leave unknown state, and alerts resolve after the configured hold time.

## Recovery and evidence

Record target, start/end time, affected journey, failure cause, action, and verification. If a dashboard says healthy while required metrics are absent, open an observability defect; missing telemetry is unknown, never zero.

## Alert names

- `ObservabilityTargetDown`
