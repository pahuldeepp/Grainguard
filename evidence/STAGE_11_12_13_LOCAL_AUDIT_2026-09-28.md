# Stages 11–13 local audit checkpoint — 2026-09-28

## Checks completed

- The local `make smoke` target passed. It checks Postgres/PgBouncer readiness,
  telemetry-ingest and device-service health/unavailable behavior, role
  privileges, and cross-database denial. It does **not** run the full stack or
  a user journey: [smoke log](stage12-local-final/make-smoke.log).
- The isolated tenant-move safety harness passed all 15 control-plane tests,
  verifies the Risk owner's source fence/copy, read-lease drain, and unrelated
  tenant preservation, then confirms cutover remains blocked at `s1`/epoch 1
  because the other eight owner adapters are missing. Its zero exit is not a
  completed tenant move: [safety log](stage12-local-final/tenant-move-risk-only-gate.log).
- A separate disposable PostgreSQL acceptance passed for the **telemetry owner**:
  twelve-table bounded copy, source fencing, target receipt/replay, target
  activation, abort/cleanup, and source epoch-advance recovery. This does not
  prove the global placement CAS/read-lease drain or the other eight owner
  receipts: [telemetry move evidence](STAGE12_TELEMETRY_TENANT_MOVE_2026-09-28.md).
- A second isolated PostgreSQL acceptance passed for the **inventory/device owner**:
  it ran all 22 device-service migrations, copied tenant/site/bin/device rows to
  a second disposable shard with a durable receipt, verified idempotent replay,
  abort cleanup and source epoch advance, and confirmed that historical CDC
  outbox or pending saga effects fail closed. This owner proof is not wired into
  the global coordinator, and tenants with CDC history remain intentionally
  blocked pending a deduplication/archive/replay protocol: [inventory move
  evidence](STAGE12_INVENTORY_TENANT_MOVE_2026-09-28.md).
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
- Worker deployment readiness was strengthened for the hardware worker,
  search indexer, and EventBridge bridge. The deployed-workload contract now
  checks readiness probes and initial scheduled-task Jobs. Local checks passed:
  search indexer 24/24, readiness contract 23/23, EventBridge readiness 2/2,
  and disposable Terraform tests 29 total (3 skipped). This does not prove AWS
  IAM permissions or successful cloud event delivery. The full EventBridge
  suite could not run in the host Python environment because `boto3` is absent.
- Prettier, ESLint, workspace TypeScript typechecks, and the Avro schema
  registration tests passed: [static checks](stage12-local-final/static-npm-checks.log).
- CodeRabbit reviewed the two scoped fixes (audit-export-worker secret
  profile and placement-test operation-ID collision); both reviews returned
  zero findings. `git diff --check` also passed.

## Full verification status

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
- Terraform 1.16.4 was verified against HashiCorp's published checksum and used
  for offline validation. `fmt -check` and `validate` pass for bootstrap-state,
  platform, and disposable roots. No AWS plan/apply or AWS API call was run.
- Runtime secret variables now use `sensitive` + `ephemeral`; five
  Secrets Manager version resources use provider `secret_string_wo` and public
  rotation counters; managed-secret tracking reads metadata only. The pinned
  AWS provider schema and a mocked sentinel fixture pass (29 disposable Python
  tests total). This is offline evidence, not a full-root live plan/state or
  Secrets Manager rotation proof; the apply readiness gate remains closed.
- Inventory/device has 3 passing owner tests and isolated PostgreSQL
  migration/copy/replay/abort/refusal acceptance. Telemetry has 4 passing owner
  tests and isolated acceptance. Both remain owner-local proofs and are not yet
  registered as trusted receipts in global cutover orchestration. Risk now also
  has owner-local acceptance: its 8-table copy receipt is committed atomically
  with target rows; target abort/source reactivation and CDC-history refusal
  passed in an isolated PostgreSQL harness. Risk/Telemetry/Inventory all refuse
  moving tenants with historical CDC outbox entries pending a dedupe-aware
  offset/replay protocol.
- Additional owner-specific safety gates now fail closed: Alerts validates its
  seven-table schema and refuses CDC-history moves; Jobs/Notifications checks
  exact owner schemas, source fencing, and drained intents/deliveries/outboxes
  (6/6 focused tests); Projection refuses movement pending partition/Kafka/CDC
  coordination (2/2 focused tests). These checks are preflights, not
  copy/activation adapters and are not wired into global placement advancement.
  Saga and Hardware have an inventory and blocker audit; their Kafka,
  MQTT, compensation, pending-secret, and late-result effects require coordinated
  protocols before copying.

## Remaining work and limits

- Tenant move cutover requires an exact nine-owner receipt roster, but that
  check is structural only and receipt provenance is not authenticated.
  Risk, telemetry, and inventory/device have owner-local move evidence; the
  other six move adapters plus trusted
  all-owner orchestration remain. Alerts and
  Jobs/Notifications have fail-closed preflights only. Projection movement in
  particular needs partition-bound history and coordinated Kafka checkpoint,
  inbox, watermark, and CDC outbox handling. A generic table copier is unsafe
  for that owner. No production global migration controller currently invokes
  all owner adapters or builds receipts from durable owner DB state. The
  request-scoped read/fill lease path, lease-drain CAS, and per-owner epoch
  fences are implemented, but do not by themselves prove all-owner cutover.
  The Risk-only harness proves a missing owner blocks cutover; no all-owner
  move or post-switch recovery has passed. After placement switches, the API
  has no automatic rollback path if target activation is partial; placement
  stays fail-closed in `activating` pending recovery.
- The mobile client no longer trusts decoded `tenant_id` claims for its local
  tenant scope and resolves membership through the BFF. Its offline auth tests
  pass. Mobile ID-token signature/issuer/audience/expiry verification remains
  unimplemented; BFF access-token verification and membership remain the API
  authorization boundary. Live IdP/JWKS, real-user enrollment, deployed HTTPS,
  and physical-iPhone OAuth/API journeys remain unproven.
- An independent web OIDC review found the offline SPA callback/config path and
  BFF access-token + membership validation coherently wired; focused dashboard
  auth/config/callback tests passed 14/14. Live provider discovery, actual
  callback registration, first-admin/tenant membership provisioning, and a
  deployed web login/API journey remain operator/live acceptance steps.
- Terraform/mobile OIDC now makes the audience mechanism explicit: Dex can
  request its cross-client audience scope; generic providers can opt into an
  `audience=` parameter; Cognito stays unchanged. Dex contract tests passed
  7/7 (127 assertions), mobile core tests 74/74, shell tests 59/59, configure
  tests 4/4, shell typecheck, Terraform validation, and formatting. Real IdP
  discovery, provider callback registration, and physical-iPhone acceptance
  remain pending.
- The scoped CodeRabbit review found four valid issues; all four were fixed:
  preserve Risk's original prepared receipt across retries, retain PostgreSQL
  microseconds during paged copies, scope inventory CDC reads through tenant
  RLS, and make worker readiness tests bind an ephemeral port. Focused tests
  and disposable PostgreSQL owner acceptances passed after those fixes. The
  EventBridge readiness test used a test-only `boto3` stub because this host
  lacks that package; no real AWS calls were made.
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
- Stage 11 has useful offline observability evidence: 65 Prometheus SLO rule
  tests, a synthetic local alert-sink rehearsal (55/55 alerts), OTLP smoke, and
  one bounded ingest-to-CDC trace/log journey. It still lacks approved and
  measured SLOs, representative cardinality/load, risk-to-alert/ACK/saga/API
  trace coverage, real AWS signals, and production paging. Stage 13 has no
  capacity certification yet: sizing remains assumptions, and the required
  sustained-load, burst, fault/zero-loss, node/AZ, canary rollback, and
  30-day availability evidence is still pending.

These results provide local/static evidence only. They do not establish that
Stages 11–13 are complete or that the disposable AWS environment is ready for
`terraform apply`.
