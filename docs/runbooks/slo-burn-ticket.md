# Runbook: SLO error-budget burn (ticket)

**Severity:** ticket, handled in working hours. **Alerts:** `SLOBurnRateFastTicket` (3x over 24h and 2h), `SLOBurnRateSlowTicket` (1x over 3d and 6h).
**Owner:** the team owning the journey in the `sli` label. Targets are PROPOSED; see [SLOs](../SLOS.md).
**Dashboard:** Grafana "GreenGuard - SLO Burn Rates (proposed)" (`greenguard-slo-burn`): panels "Error ratio 1h by SLI" and "Error budget remaining".

## Symptom

A slow, steady loss of error budget that will exhaust the 30 day budget before the window ends (about 10 days at 3x, never lasting the window at 1x).

## Diagnosis

1. Read `slo:error_budget_remaining:ratio30d{sli="<sli>"}` and the 1h and 6h burn panels; establish whether the burn is constant, periodic (batch jobs, business hours) or growing.
2. Break the bad events down by the bounded labels available (route, status_code, outcome metric) as in the [page runbook](slo-burn-page.md) step 2.
3. Look for a chronic cause: a slow query class ([database saturation](database-saturation.md)), a flaky provider ([notification delivery](notification-delivery.md)), a consistently lagging consumer ([streaming backlog](streaming-backlog.md)).

## Mitigation

Open a ticket with the diagnosis and schedule the fix; freeze risky releases for this journey if the remaining budget is under 25%. If the burn accelerates past 6x the page alert takes over.

## Escalation

If the budget remaining is below zero, follow the [page runbook](slo-burn-page.md) escalation and review targets with the SLO owner rather than editing rules to silence the alert.

## Verification

The burn panels return under 1x and the alert resolves without a threshold change.
