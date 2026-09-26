# Runbook: run the alert failure rehearsal

**Owner:** platform operations.  
**Signals:** none; run before changing `infra/observability/rules/*.yaml`, `alertmanager.yaml` or a runbook, and before a stage 11 sign-off.  
**Scope:** proves alert -> Alertmanager -> webhook notification -> runbook link with a synthetic metrics target. It does not touch real brokers, databases or services (see [rehearsal-failures.md](rehearsal-failures.md) for what stays unproven).

## Triage

1. Docker must be running with the Prometheus and Alertmanager images pinned in `infra/observability/compose.yaml`. The rehearsal reads the tags from that file; it never uses a different version.
2. Check `docker stats --no-stream`. The rehearsal adds two small containers (about 100 MB). Do not start Grafana, Loki or Tempo for it.
3. Free ports 29090 (Prometheus), 29093 (Alertmanager), 29100 (synthetic target) and 29180 (webhook receiver), or override with `REHEARSAL_PROM_PORT`, `REHEARSAL_AM_PORT`, `REHEARSAL_TARGET_PORT`, `REHEARSAL_HOOK_PORT`.
4. Run the static check first: `make observability-runbook-check`. Every alert needs `severity`, `summary`, a `runbook_url` that is an existing file under `docs/runbooks`, the sections `Triage` and `Recovery and evidence`, and its own name written in the runbook.
5. Run `make observability-rehearse`. It runs the unit tests, generates a copy of the rules under `infra/observability/rehearsal/.generated/` with every `for:` and `[range]` divided by `REHEARSAL_FACTOR` (default 60, so `5m` becomes `5s`), starts project `greenguard-obs-rehearsal`, and drives one alert at a time: inject, pending, firing, webhook notification, heal, resolved.
6. Read the table. Each row lists seconds since injection for pending, firing and notified, and seconds since heal for resolved. `OK` means the alert reached the webhook with the rule's severity and `runbook_url`, the runbook file exists, and a resolved notification followed.

## Recovery and evidence

The script always runs `docker compose down -v` for its own project and deletes `.generated/`. If it was killed, run `docker compose -p greenguard-obs-rehearsal -f infra/observability/rehearsal/compose.yaml down -v` and delete `infra/observability/rehearsal/.generated/`. Never stop containers from other projects. Save the table and the command output under `evidence/`; state the divisor, because timings are scaled and are not production detection times.
