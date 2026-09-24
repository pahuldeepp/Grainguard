# Stage 06b validation: workflow-alerts (alert lifecycle)

Date: 2026-09-24. Local only; no remote CI run yet. Postgres 16 + PgBouncer from
`infra/compose/compose.yaml`. Kafka, Connect, RabbitMQ were not started.

Status: **implemented locally, not complete** — the Kafka adapter and CDC capture
of `greenguard.alerts.lifecycle.v1` are UNVERIFIED (Stage 06e).

## Provisioning

`greenguard_alerts` with runtime `alerts_app` (NOBYPASSRLS, no ownership) and owner
`alerts_migrator`; env `ALERTS_DB_PASSWORD`, `ALERTS_MIGRATOR_PASSWORD`,
`ALERTS_DATABASE_URL` (PgBouncer), `ALERTS_DIRECT_URL`, `ALERTS_MIGRATION_URL`.

```
$ npm run migrate -w services/workflow-alerts
  └─ 20260924100000_alert_lifecycle/
All migrations have been successfully applied.
```

## Tests (`npm test -w @greenguard/workflow-alerts`, live DB)

```
ℹ tests 44
ℹ pass 44
ℹ fail 0
```

| Requirement                                              | Test                                                              |
| -------------------------------------------------------- | ----------------------------------------------------------------- |
| Hysteresis open/update/hold/resolve, new window reopens  | `consumer/handler.test.ts` hysteresis                              |
| Outbox rows validate against alert lifecycle contract    | handler: every outbox row is a valid alert lifecycle event        |
| Duplicate event returns original effect                  | handler: duplicate delivery                                       |
| Same event_id, different payload = conflict, no write    | handler: same event_id with different content                     |
| Stale / reordered risk events cannot regress episode     | handler: stale or reordered assessments                           |
| Crash before COMMIT leaves no inbox/transition/outbox    | handler: crash before COMMIT (+ redelivery applies once)          |
| Deterministic event IDs on replay                        | handler: event IDs derive from (tenant, episode, version, type)   |
| One episode under 8 concurrent scores                    | handler: concurrent scores for one bin                            |
| Unique window / one-active constraint under concurrent SQL | `migrations.test.ts`                                            |
| Forced RLS on all 7 tables, no DELETE, non-owner role    | `migrations.test.ts`, `api/api.test.ts` SQL layer                 |
| Ack once + audit + alert.acknowledged; Idempotency-Key   | `alerts/lifecycle.test.ts`, `api/api.test.ts`                     |
| Ack vs escalate: both orders and 5 concurrent rounds     | `alerts/lifecycle.test.ts` (exactly one effect each round)        |
| Suppressed escalation writes a no-op receipt, no event   | lifecycle: ack first                                              |
| Bounded row lock (409 resource_locked)                   | lifecycle: held row lock                                          |
| 428/412/400, viewer 403, device 403, anonymous 401       | `api/api.test.ts`                                                 |
| Tenant B cannot list/read/ack tenant A (HTTP and SQL)    | `api/api.test.ts`                                                 |
| Consumer loop: commit after effect/quarantine, retry, no skip | `consumer/runner.test.ts` (fake source)                     |

Coverage (`npm run coverage -w @greenguard/workflow-alerts`, c8 on dist):
`All files | 99.72 stmts | 96.33 branch | 100 funcs | 99.72 lines`.

Contracts (`npm test -w @greenguard/contracts`): `ℹ pass 17  ℹ fail 0`, including
five valid alert fixtures and eight invalid ones under `tests/fixtures/events/alerts/`.

## make verify

Ran through check-plan, db-migrate (including workflow-alerts), risk tests,
format:check, lint, typecheck and all npm workspace tests (device-service 112/112,
workflow-alerts 44/44, contracts 17/17), and kafka-transport Go tests. It then
stopped at `cd packages/go-common && test -z "$(gofmt -l .)"`: the untracked
`packages/go-common/common_test.go` belongs to the concurrent Go transport work and
is not part of this change. The remaining Go/build steps were not reached.

## Not verified

- Real Kafka consumption of `risk.assessed` and quarantine publishing.
- Debezium capture of `greenguard_alerts_outbox`; Schema Registry registration.
- A cross-tenant escalation scheduler (only the per-episode worker step exists).
- SonarQube scan (owned by another session).
