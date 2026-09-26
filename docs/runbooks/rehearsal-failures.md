# Runbook: interpret alert rehearsal failures

**Owner:** platform operations.  
**Signals:** a `FAILED:` row from `make observability-rehearse`, or problems from `make observability-runbook-check`. Companion to [rehearsal-run.md](rehearsal-run.md).

## Triage

| Message                                                            | Meaning                                                      | Fix                                                                                                                                      |
| ------------------------------------------------------------------ | ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `[missing-severity]`, `[missing-summary]`, `[missing-runbook-url]` | The rule lacks a required label or annotation.               | Add it to the rule file.                                                                                                                 |
| `[dangling-runbook]`                                               | `runbook_url` is not an existing file under `docs/runbooks`. | Create the runbook or correct the path.                                                                                                  |
| `[missing-section]`                                                | The runbook lacks `Triage` or `Recovery and evidence`.       | Add the heading.                                                                                                                         |
| `[alert-not-in-runbook]`                                           | The runbook never names the alert.                           | Name the alert under Signals so a responder can search for it.                                                                           |
| `timed out ... waiting for pending`                                | The expression never became true with the synthetic series.  | The metric name or label in the rule changed; update `infra/observability/rehearsal/target.mjs` to the exact series.                     |
| `timed out ... waiting for firing`                                 | Pending never became firing.                                 | Check the scaled `for:` in `.generated/rules/platform.yaml`; a rule that flaps between evaluations resets its timer.                     |
| `fired ... before the ... for window`                              | The alert skipped its `for:` hold.                           | The rule lost its `for:`; restore it.                                                                                                    |
| `timed out ... webhook firing notification`                        | Prometheus fired but Alertmanager did not deliver.           | Check `alertmanager.yaml` route, receiver and `group_wait`; `docker logs greenguard-obs-rehearsal-alertmanager-1` (run before teardown). |
| `severity X != Y`, `runbook_url differs`                           | The notification differs from the rule.                      | Check routing or relabelling in `alertmanager.yaml`.                                                                                     |
| `timed out ... resolved notification`                              | Alert cleared but no `send_resolved` message arrived.        | Ensure `send_resolved: true` on the receiver.                                                                                            |
| `promtool` error before the run                                    | A rule does not parse.                                       | Fix the expression; the harness checks the scaled copy so a bad rule fails before any container test.                                    |

## Recovery and evidence

A rule added later needs a `SCENARIOS` entry in `scripts/observability-rehearsal-lib.mjs` and a control in the target, or it must be listed as not rehearsed with the reason. Alerts that need real dependencies (brokers, replication slots, cloud services) are rehearsed only in the integrated Stage 10d stack. Absent-metric alerts such as `ProjectionFreshnessUnknown` carry no `job` label, so their notifications cannot say which service is silent; that is a property of `absent()`, not a rehearsal fault. Record any failure, fix and passing rerun in the evidence file.
