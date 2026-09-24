# Stage 06a-1 risk-engine core (local)

Date: 2026-09-24. Scope: `services/risk-engine` (database `greenguard_risk`, event-time lot join, transactional apply, consumer skeleton), plus additive provisioning in `infra/compose/init-databases.sql`, `infra/compose/pgbouncer/pgbouncer.ini`, both compose files, `scripts/bootstrap.mjs`, `.env.example`, `Makefile`, `scripts/coverage.mjs`, `sonar-project.properties` and `.github/workflows/ci.yml`. This does not complete Stage 06a or Stage 06.

## Commands run and results

Local `.env` and `.local/pgbouncer/userlist.txt` were extended with the risk secrets and URLs that `scripts/bootstrap.mjs` now generates. Bootstrap itself was not re-run, because it also runs `npm ci`.

```text
$ make db-up
greenguard-dev-postgres-1 Healthy, greenguard-dev-pgbouncer-1 Healthy; init-databases.sql re-applied
$ psql ... "select datname, owner"      -> greenguard_risk|risk_migrator
$ python -m risk_engine.migrate          -> risk migrations applied: 000001
$ python -m risk_engine.migrate          -> risk migrations applied: none (up to date)
$ make risk-test                         -> Ran 64 tests ... OK (0 skipped; live DB tests ran)
```

Coverage was run by hand with the same arguments that `scripts/coverage.mjs` now uses. It was not run through `make coverage`, as explained below.

```text
$ coverage run --branch --source=services/risk-engine/risk_engine -m unittest discover -s services/risk-engine -t services/risk-engine -p 'test_*.py'
Ran 64 tests ... OK
TOTAL 912 statements, 214 branches: 99% (apply, consumer, events, health, join, kafka_source,
migrate, scoring: 100%; main.py 97% (the `__main__` guard line); store.py 99%)
```

`ruff check --select F,C901,E9` (McCabe at most 10) passed. Ruff was used only as a local check and is not a pinned project dependency.

`make verify` ran `check-plan` (passed), `db-migrate` (including the new `risk-migrate`) and `risk-test` (64 OK). It then **failed at `npm run format:check`** on `services/workflow-alerts/src/alerts/policy.ts`. That untracked file belongs to concurrent Stage 06b work in another session and was not touched here. The later verify steps (lint, typecheck, npm/Go tests, build) did not run in this session, so `make verify` is **not** green.

`make coverage` and `make sonar-*` were **not run**: another session owns the SonarQube scan now. The Sonar Python rules (cognitive complexity, duplicated literals) are therefore unverified.

## What the live tests prove (`services/risk-engine/test_live_db.py`, PostgreSQL 16 on 127.0.0.1:55432)

- Forced RLS with two tenants on `consumer_inbox`, `device_bindings`, `bin_lot_intervals`, `device_risk_streams`, `risk_assessments` and `outbox_events`. Another tenant or no tenant sees 0 rows, even as the owner. A cross-tenant INSERT fails with 42501, a cross-tenant UPDATE matches 0 rows, and a consumer transaction for tenant B cannot use A's binding (`binding_state_unavailable`).
- Role limits: `risk_app` DELETE fails with 42501 on all 7 tables. UPDATE of `lot_id`/`effective_from`, assessments, outbox and inbox fails with 42501, and `risk_app` cannot SELECT the outbox. Reclosing a closed interval fails with 23514 from the trigger.
- The GiST exclusion rejects an overlapping interval (23P01). A non-increasing `occupancy_version` is rejected with 23514.
- A crash before commit (outbox insert raises) leaves no receipt, assessment or outbox row. Redelivery then applies once. Redelivery after commit is a no-op. A replay under a new consumer name, through PgBouncer (`RISK_DATABASE_URL`), returns the same `event_id` and writes no second outbox row.
- Stale binding (inventory v1 after v5) and stale lot versions are ignored. A direct regressing UPDATE is rejected by the trigger with 23514.
- A late reading at 11:00, after wheat→canola at 12:00, is scored as wheat (score 0). A reading at exactly 12:00 is scored as canola (score 50).
- Both outbox rows, read back from PostgreSQL, validate against `contracts/events/risk-assessed.v1.schema.json` (jsonschema 4.26.0, Draft 2020-12 with format checks). Causation, correlation and traceparent are preserved.
- Invalid measurements roll back (no receipt). `quarantine_samples` stores one bounded slot per `offset % 1000`, overwritten on repeat.
- Connection failure maps to a transient `StoreError` (no SQLSTATE); `1/0` maps to 22012.

Unit tests cover the half-open boundaries, overlap/missing/stale-feed not-ready outcomes, the binding version and conflict rules, and every quarantine reason. They also cover bounded transient retry, exhaustion that stops without commit, 22/23 → `db_rejected`, 42501 and other states as hard errors, and duplicate-with-different-payload. Consumer tests cover pausing only the not-ready partition while lot records keep flowing, quarantine only after the wait bound, quarantine failure stopping without commit, and checkpoint → watermark promotion. The Kafka adapter is tested against a stub client (commit after `offset+1`, `auto.offset.reset=error`, errors are hard).

## UNVERIFIED / not built

- **Live Kafka path**: no broker was started (memory and concurrency constraints). `KafkaSource` and `risk_engine.main` have not consumed a real topic, and pause/seek/resume, rebalance behaviour and the checkpoint-plus-high-watermark freshness rule are untested live.
- **CDC publication of the risk outbox**: the migration creates the `greenguard_outbox` publication and the `cdc_reader` snapshot policy. No Debezium connector exists for `greenguard_risk`.
- **Transformer routing of `risk.assessed`** to `greenguard.risk.assessment.v1`: not built. This is deferred until the Go Kafka transport refactor lands.
- Docker image (`services/risk-engine/Dockerfile`, digest-pinned `python:3.14.7-slim-bookworm`) was not built.
- `risk.assessment_invalidated` after a backdated lot change: detected and counted only (no contract). There is no lot retirement event.
- CI: no remote run. The `make verify` failure above is unrelated to this change.
