# Stage 08 tenant hardening: three isolation findings

Date: 2026-09-25. Local, uncommitted checkout; shared dev stack (`greenguard-dev-postgres-1`,
RabbitMQ via `make rabbitmq-test`). Commands ran with `set -a; . ./.env; set +a`. Remote CI has not run.

Each fix was written test-first: the new live test ran against the unfixed schema, failed, and then
passed after the forward-only migration was added.

## Finding 1: jobs-worker `app.scope` policies (MEDIUM)

- Migration `services/jobs-worker/migrations/000005_id_only_selectors.up.sql` drops the
  `dispatch_scan`, `redrive_scan` and `dead_scan` policies. It adds owner-only (`jobs_migrator`)
  SELECT policies and three SECURITY DEFINER selectors with `search_path = public`, batches clamped
  to 1..1000, `REVOKE ALL FROM PUBLIC` and `GRANT EXECUTE TO jobs_app`:
  `jobs_due_dispatch_refs` (tenant_id, intent_id, available_at),
  `jobs_dead_intent_refs` (tenant_id, intent_id) and
  `jobs_dead_letter_refs` (tenant_id, intent_id, delivery_generation).
- Code: `store.go` `ScanDue`, `dead.go` `DrainDead` and `redrive.go` `listDead` call the
  selectors. Payload, `last_error`, locking and updates still run inside `WithTenant`.
  `Quarantine` (a non-tenant table) no longer sets `app.scope`, and no Go code sets it now.
- Tests: `selectors_test.go`. The removed `TestDispatchScanPolicyIsReadOnlyIdentifiers` was
  replaced by these stronger tests.

Result before the fix (`go test -run 'Scope|Selector|NoPolicy' .`):

```
app.scope=redrive-scan exposed 3 notification_intents rows without a tenant
app.scope=dispatch-scan exposed 3 dispatch_outbox rows without a tenant
app.scope=dead-scan exposed 3 dead_letter_outbox rows without a tenant
session-scope policies remain: [dispatch_outbox.dispatch_scan notification_intents.redrive_scan dead_letter_outbox.dead_scan]
```

After `make jobs-migrate`, `cd services/jobs-worker && GOFLAGS=-mod=mod go test -race -cover -count=1 ./...`:

```
ok  greenguard.local/jobs-worker          coverage: 90.2% of statements
ok  greenguard.local/jobs-worker/cmd/migrate  coverage: 100.0%
ok  greenguard.local/jobs-worker/rabbit   coverage: 85.1%
```

`make rabbitmq-test` ran three times. Run 1 failed:
`--- FAIL: TestLiveDispatchSurvivesBrokerRestartWithStableIDs (0.32s)`. The failure message was
not captured. Runs 2 and 3 passed, each with `missing=0 of 120`, `duplicate-copies=0` and all
three Live tests PASS. The cause of run 1 was not investigated further.

## Finding 2: projection-builder CDC snapshot policy (MEDIUM, review R1)

- Migration `services/projection-builder/migrations/000012_cdc_snapshot_guard.up.sql`. It raises
  `undefined_object` if `cdc_reader` is missing. Otherwise it re-grants CONNECT, USAGE and
  SELECT and recreates `cdc_outbox_snapshot`, so it is safe to apply more than once. 000009 was
  not changed.
- Test: `migrations/cdc_snapshot_test.go`. It runs the 000009 grant block with the role renamed
  and gets success, which reproduces the silent skip. It runs 000012 with the role renamed and
  gets an error naming the role. It runs 000012 with the real role and gets success. All of this
  happens in transactions that roll back, so the cluster role is never dropped. The test then
  checks that the applied policy and SELECT grant exist and that the role has no write grants.
- Before the migration existed, both tests failed (`file does not exist`). After `make projection-migrate`,
  `schema_migrations` = `12|f`. `go test -race -cover ./...` passed in every package.

## Finding 3: risk-engine global identifiers (MEDIUM)

- Migration `services/risk-engine/migrations/000004_tenant_scoped_keys.up.sql`:
  - `risk_assessments` PK becomes (tenant_id, assessment_id) and UNIQUE becomes (tenant_id, event_id).
  - The invalidation FK is repointed to the new PK, and `risk_assessment_invalidations` UNIQUE
    becomes (tenant_id, event_id).
  - `outbox_events` PK becomes (tenant_id, event_id).
  - RLS and grants are untouched. The Python code had no ON CONFLICT on these keys and needed no change.
- New live tests in `test_live_db.py`: `test_same_ids_in_two_tenants_neither_collide_nor_leak` and
  `test_every_unique_key_on_tenant_tables_is_tenant_scoped`. Before the fix they reported
  `UniqueViolation ... "risk_assessments_pkey"` and 4 non-tenant keys. After
  `make risk-migrate` (`applied: 000004`), `make risk-test`: `Ran 70 tests ... OK`.
- The Debezium raw key for the risk outbox is now `{tenant_id, event_id}`. The raw topic has one
  partition and the transformer takes its keys from the value. `make events-e2e` was **not** re-run.

## `make verify`

Exit 2. It stopped at typecheck in `services/tenant-control-plane`, another session's untracked
work: `src/testing/api.ts: Cannot find module '../app.js'`. Every step before it passed: migrations,
risk-test (70 OK), format check and lint. The Go steps come after typecheck in `verify`, so they did
not run there. I ran gofmt, vet and the race tests directly for jobs-worker and projection-builder,
and all were clean. SonarQube, `make coverage` and CodeRabbit were not run.
