# Runbook: elevated API server errors

**Severity:** page after alert threshold; service owner responds.  
**Signals:** `APIHighServerErrorRate`, RED dashboards, SLO bad-event rate.

## Triage

1. Identify affected service and bounded route template; compare request rate, 5xx, timeout, p95/p99, and 4xx/429 separately.
2. Follow exemplifying failing traces. Locate the first failing span and inspect its dependency spans. Search structured logs using trace ID; never paste tokens or customer data into incident notes.
3. Check recent deployment/configuration changes, DB pool wait/slow-query fingerprint, Kafka/Rabbit backlog, and readiness.
4. Mitigate at the owning layer: rollback the implicated release/configuration or restore dependency capacity. Do not mask overload by dropping timeouts or excluding requests from the SLI.
5. Confirm errors return to baseline, traces show successful completion, and the alert resolves.

## Recovery and evidence

Record the affected operation, verified cause, mitigation, error-budget impact, and recovery time. Follow the incident review process for repeated or budget-consuming events.
