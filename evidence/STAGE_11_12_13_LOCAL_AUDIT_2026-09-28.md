# Stages 11–13 local audit checkpoint — 2026-09-28

## Checks completed

- The local `make smoke` target passed. It checks Postgres/PgBouncer readiness,
  telemetry-ingest and device-service health/unavailable behavior, role
  privileges, and cross-database denial. It does **not** run the full stack or
  a user journey: [smoke log](stage12-local-final/make-smoke.log).
- The isolated tenant-move harness passed all 14 control-plane placement
  tests and a Risk-owner move: lease drain, source writer fence, epoch 1→2,
  copied row/digest verification, and unrelated-tenant preservation. This is
  one owner only: [move log](stage12-local-final/tenant-move-local-final.log).
- The shared `db-migrate` target now includes `notification-service`. Its
  optional-hold migration accepts both the current `hold` value and historical
  `hold_expired` rows; a scratch-database regression covers preservation.
  The placement test also now guarantees its conflicting operation ID differs
  from the original UUID.
- Runtime secret lifecycle tests passed 23/23, including the added
  Terraform-generated `audit-export-worker` registry profile. Deployment and
  teardown unit checks passed (15 Python tests, data-plane Argo contract,
  54 teardown cases). See [secret tests](stage12-local-final/runtime-secret-lifecycle-tests.log),
  [deployment checks](stage12-local-final/deploy-destroy-python-tests.log),
  [Argo checks](stage12-local-final/data-plane-applications-review.log), and
  [teardown checks](stage12-local-final/teardown-test-final.log).
- Helm lint/render and the static chart acceptance gate passed, including
  scheduling, autoscaling, network-peer, and reject-fixture checks:
  [Helm log](stage12-local-final/helm-validation-final.log).
- Prettier, ESLint, workspace TypeScript typechecks, and the Avro schema
  registration tests passed: [static checks](stage12-local-final/static-npm-checks.log).
- CodeRabbit reviewed the two scoped fixes (audit-export-worker secret
  profile and placement-test operation-ID collision); both reviews returned
  zero findings. `git diff --check` also passed.

## Full verification status

- A fresh `make verify` attempt did **not** pass. The default Compose ports
- Full `make verify` and `make smoke` passed against a newly created disposable
  Compose project and database, then the harness removed only that project and
  its volume. The full gate includes migrations, the 97-test Risk suite,
  workspace checks/tests, Go race suites, and service builds. One optional
  shard-live test was skipped because no isolated shard acceptance URL was
  configured. Logs: [full verify](stage12-local-final/scratch-make-verify.log),
  [smoke](stage12-local-final/scratch-make-smoke.log), and
  [scratch cleanup](stage12-local-final/scratch-compose-down.log).
- The shared development database is **not** clean: its existing
  `greenguard_jobs` ledger was already at version 7, dirty, and lacks the
  `greenguard_internal.tenant_ownership` foundation from migration 6. The
  shared migration attempt applied notification migrations while preserving
  existing rows, then stopped at this jobs ledger. It was not forced or
  rewritten. Keep shared-DB acceptance separate until that database is backed
  up and reconciled. See [shared migration attempt](stage12-local-final/db-migrate-final.log).
- Terraform is not installed in this checkout's command environment, so
  Terraform format/validate/plan were not rerun here. No Terraform plan/apply,
  AWS API call, or production change was performed.

## Remaining work and limits

- Tenant moves are still Risk-only. Eight other sharded database owners do
  not have owner-specific copy/prepare/fence/verify/activate adapters and
  receipts. Generic table discovery is not sufficient: partitioned projection
  history, worker queues/outboxes/checkpoints, and external effects need
  explicit handling before all-owner movement is safe.
- Stage 12 AWS apply remains correctly blocked by the Terraform readiness
  gate. The root is a partial foundation; managed data-plane services,
  populated secrets, real migrations and service health, immutable application
  images/release inputs, real-user tenant enrollment, and web/iPhone journeys
  still need closure and live proof. Existing OIDC is preserved; external IdP
  callback registration, first-admin enrollment, and physical-iPhone
  configuration remain operator steps. Mobile ID-token signature validation
  also remains a documented gap because the Hermes runtime lacks a maintained
  verifier primitive.
- `terraform destroy` requires the verified wrapper to run post-destroy
  inventory; raw Terraform has no reliable post-destroy hook. Inventory is
  scoped to the selected disposable cell and region and cannot prove
  account-wide, multi-region absence of every billable GreenGuard resource.
- Stage 11 still lacks representative production-like cardinality/load,
  full risk/projection/notification trace coverage, AWS signals, paging, and
  approved SLOs. Stage 13 still lacks the specified capacity/soak, availability,
  and zero-loss certification.

These results provide local/static evidence only. They do not establish that
Stages 11–13 are complete or that the disposable AWS environment is ready for
`terraform apply`.
