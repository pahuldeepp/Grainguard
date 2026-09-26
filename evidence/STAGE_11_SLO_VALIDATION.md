# Stage 11 SLO validation

Scope: `docs/SLOS.md`, `infra/observability/rules/slo.yaml`, `infra/observability/tests/slo.test.yaml`, `infra/observability/grafana/dashboards/slo.json`, `docs/runbooks/slo-burn-page.md`, `slo-burn-ticket.md`, `slo-integrity.md`. Image `prom/prometheus:v3.2.1` (same as `infra/observability/compose.yaml`). No stack was started.

## Commands run and results

Test-first (red): tests written before the rules file existed.

```
promtool test rules /w/tests/slo.test.yaml     (rules/slo.yaml absent)
  WARNING: no file match pattern /w/rules/slo.yaml
  FAILED: ... (every alert and expr expectation failed with got: nil / got: [])
```

Green after the rules were added (one intermediate failure was a wrong test fixture for the freshness burn, 30% slow events is 6x not above 14.4x; the fixture was corrected to 80% slow, not the rule):

```
promtool check rules /w/rules/slo.yaml        -> SUCCESS: 65 rules found
promtool test rules /w/tests/slo.test.yaml    -> SUCCESS
promtool test rules /w/tests/platform.test.yaml -> SUCCESS (existing tests unaffected)
node scripts/observability-validate.mjs       -> observability config validation passed: 4 dashboards, bounded-label audit, rules, and runbooks
node -e JSON.parse(slo.json)                  -> ok
grep -E "tenant_id|device_id|request_id|event_id|trace_id|span_id" rules/slo.yaml -> no matches
npx prettier --check docs/SLOS.md docs/runbooks/slo-*.md slo.json slo.yaml slo.test.yaml -> All matched files use Prettier code style
runbook_url targets exist: slo-burn-page.md, slo-burn-ticket.md, slo-integrity.md
```

## What the tests prove

Healthy series silent (all four burn alerts, ratio 0); 20x burn fires FastPage; 3-minute spike with 5m ratio high but 1h ratio about 5x does not page (long window disagrees); recovered incident with 1h ratio above 14.4x and 5m ratio 0 does not page (short window disagrees); 8x burn fires SlowPage only; 4x burn fires FastTicket only; 1.5x burn fires SlowTicket only; notification (1% budget) and projection freshness SLIs fire with their own budgets; integrity alerts fire on increases and stay silent when flat.

## UNVERIFIED

- All targets, windows and thresholds are proposals with no load data; no owner approval.
- Rules were tested only with synthetic series; not run against a live Prometheus or real service metrics.
- The `slo.json` dashboard was JSON- and label-checked only, not loaded in Grafana; panel queries were not executed.
- The 28d recording rules were not exercised in unit tests (only up to 3d); their cost is unmeasured.
- The alert routes in Alertmanager (severity page/ticket) were not exercised.
- Journeys without metrics (alert opened, acknowledgement, saga, commit-to-canonical) have no SLO; see "Missing instrumentation" in `docs/SLOS.md`.

## Follow-up dashboard runtime check (2026-09-26)

The isolated observability profile reached ready state and Grafana's authenticated dashboard API listed both SLO dashboards (`greenguard-slo` and `greenguard-slo-burn`). Prometheus loaded the SLO alert groups alongside platform and broker groups. App services were not started in this isolated profile, so SLO panel queries had no representative live service traffic and were not treated as validated against workload data. No owner approved the candidate boundaries or targets, and SLO alert delivery through the sink remains unverified.
