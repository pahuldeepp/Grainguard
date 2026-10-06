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

## Follow-up verification — 2026-09-28

- The disposable Compose wrapper in `scripts/stage12-compose-gate.mjs` completed
  `make verify` and `make smoke` using a unique generated environment file,
  Compose project, host ports, and PostgreSQL volume. It removed only that
  project and volume after both targets passed. The smoke reported live DB and
  PgBouncer readiness, unavailable-DB behavior, application-role privileges,
  and cross-database denial. Risk tests passed 97 with one optional shard-live
  test skipped; six optional real-Redis tests were skipped. This remains local
  acceptance, not a full 4-shard or AWS run.
- The wrapper has static tests for generated control-plane URL/token pairing,
  explicit recursive Makefile selection, and its generated Makefile behavior
  (3/3 passed). Workspace tests/builds and Go race/vet/build stages completed
  in the same isolated verification run.
- One earlier manual attempt preceded the recursive-Makefile fix and entered
  the repository's shared migration target before stopping at the existing
  dirty `greenguard_jobs` migration ledger (version 7). It was not forced or
  repaired. Subsequent full verification used the corrected wrapper and a
  newly isolated database. Do not use the shared development database for
  acceptance until it is backed up and reconciled.
- Stage 13 now has a validate-only, offline workload-manifest harness. Its
  five tests cover absent/non-local environment rejection, bounded settings,
  and exact run-scoped ownership checks. It performs no workload, fault, or
  cleanup action and explicitly reports `certification: false`; Stage 13 stays
  planned until live load, soak, and failure exercises are measured.
- At this checkpoint, Stage 11's gateway RED metrics and raw Terraform's final
  destroy inventory were still open. **Superseded by the follow-up below:** a
  separate internal gateway metrics listener and scrape-only policy were added,
  and a Terraform destroy sentinel now runs scoped post-destroy inventory on a
  full-state destroy. The earlier statements are retained as historical status,
  not current status.

## Follow-up verification — current integration changes

- Gateway now serves RED metrics on a separate application-metrics listener;
  the public gateway listener continues to return 404 for `/metrics`. Gateway
  tests passed 12/12, including monotonic histogram buckets, `+Inf` count, and
  aborted-request accounting.
  The observability contract checker passed and verifies rendered scrape policy
  selectors against Prometheus pod labels. These are offline checks; no live
  Prometheus scrape or representative load was run. Approved SLOs, cardinality
  limits, end-to-end risk-to-alert traces, and paging remain unproven.
- A Terraform destroy sentinel captures scoped resource/secret inventory before
  teardown and runs the final inventory after the complete managed graph is
  destroyed. Offline Terraform validation and lifecycle/teardown tests passed.
  This guarantee applies to a full Terraform state containing the sentinel;
  partial-state recovery still uses the verified wrapper. Inventory checks the
  configured disposable scope and region plus named global resources, not every
  account region, and cannot establish account-wide absence of every billable
  GreenGuard resource.
- The latest combined disposable acceptance/deployed-workload/runner regression
  suite passed 47 tests. The acceptance checker deliberately returns
  `BLOCKED` until live evidence is independently approved. The deployment
  contract currently contains 30 releases and 20 image identities and reports
  7 blocking gaps. This is static contract validation, not proof of a healthy
  deployed environment.
- `git diff --check` and Python byte-compilation of the two modified disposable
  acceptance checkers passed. `bash scripts/helm-validate.sh` also passed all
  rendered chart, autoscaling, scheduling, network-peer, and reject-fixture
  checks on this rerun after correcting stale worker-probe assertions and
  removing the search-indexer's conflicting ephemeral `/tmp` volume mount.
- Tenant move capability checks now reject all nine sharded data owners until
  each supplies a complete all-owner move adapter; local Inventory, Risk, and
  Telemetry primitives no longer make an owner appear globally migratable.
  Malformed adapter boundary declarations also fail closed. The focused
  tenant-move tests passed 7/7 and CodeRabbit reported zero findings for those
  files. This is safer admission behavior, not a completed tenant move; Docker
  and the owner-specific broker, CDC, saga, MQTT, Cassandra, and replica-freshness
  acceptance requirements remain unavailable or unimplemented.
- OAuth/OIDC configuration review found the existing provider-neutral flow
  internally consistent: Terraform exports the web and `greenguard://` mobile
  callbacks, dashboard runtime config, and BFF issuer/JWKS/audience; mobile PKCE
  and tenant membership resolution remain in place. Mobile configuration tests
  passed 4/4, identity contract tests 7 runs/127 assertions, and dashboard auth
  tests 8/8. Provider callback registration, real-user membership enrollment,
  live discovery/JWKS/token claims, browser login, and physical-iPhone journeys
  still require operator and deployed-environment proof.
- The full tenant-control-plane `npm test` command could not pass offline because
  it includes live database fixtures requiring `CONTROL_DATABASE_URL` and
  `CONTROL_DIRECT_URL`; no database was configured or modified. Its build
  completed, and the isolated tenant-move tests passed separately.
- Gateway metrics now count premature connection closes once with an `aborted`
  status label; completed responses retain their HTTP status. The metrics server
  binds to loopback by default, and only the explicitly configured Gateway
  chart profile opts into pod-wide binding for Prometheus scraping. Gateway
  tests passed 12/12, and Helm/observability checks passed. These are still
  offline tests, not a live scrape or load measurement.
- Disposable ECR names now include the environment and a hash of the cell name;
  runtime/migration promotion continues to use Terraform's URL outputs with
  stable image keys. The shared legacy `greenguard/<service>` repositories are
  intentionally excluded from cell cleanup to avoid deleting another cell's
  images. Promotion tests and the image-inventory check passed. Existing state
  containing the legacy shared repository addresses requires review before
  applying because Terraform could otherwise propose replacement/deletion.
  Teardown now tags and directly inventories the exact cell VPC, internet
  gateway, NAT gateways and EIPs, and includes Secrets Manager secrets pending
  deletion. Lifecycle audit tests passed 13/13 (101 assertions), teardown tests
  passed 61/61, manifest tests 8/8, and both disposable/platform Terraform roots
  passed formatting and validation using the repository-pinned binary. The final
  lifecycle suite is now 14/14 (121 assertions); it covers pre-cleanup state
  missing newer manifest/secret fields and fails if commented-out ECR settings
  look enabled. Secrets Manager inventory includes items scheduled for deletion.
  These checks do not establish live AWS deletion or account-wide/all-region
  absence.
- The migration-image publish job's malformed Sigstore installer pin was
  corrected to the verified v4.1.2 commit, and `scripts/check-image-inventory.sh`
  now asserts the exact pin. Image inventory, `actionlint`, and a malformed-pin
  negative check passed. The disposable GitOps acceptance release includes the
  complete migration-image digest map. This fixes CI/deployment wiring only; it
  does not publish images or prove cloud pulls.
- No fresh full Compose `make verify`/smoke run was possible after these changes:
  Docker CLI is installed but its daemon socket is absent. The earlier isolated
  Compose evidence above remains the last full local-stack run; no shared DB
  was touched during this follow-up.
- Legacy Terraform state without the destroy sentinel is blocked from raw
  `terraform destroy` before AWS calls unless the exact verified-wrapper scope
  marker is present. The teardown suite covers both the rejection and wrapper
  path; this is an offline guard test, not a live AWS destroy rehearsal.

## Follow-up verification — 2026-09-29

- Four-shard Read API readiness now requires all four shard providers to be
  healthy. The regression test covers all healthy, one unavailable, and three
  unavailable shard providers. Read API build and shard tests passed (6/6),
  and the Terraform shard-runtime contract tests passed (3/3). The
  `read-entitlement-projector` registry identity was aligned with its runtime
  identity (`read-api`). CodeRabbit reviewed the Read API changes with no
  findings. These checks do not prove live RDS health or EKS pod readiness.
- Tenant bootstrap orchestration now waits for every in-flight owner operation
  to settle before returning a preparation or activation failure, preventing an
  immediate retry from overlapping the prior owner calls. Tenant-control-plane
  build and offline bootstrap/preflight tests passed (7/7); CodeRabbit reported
  no findings for the scoped bootstrap code. This remains a protocol harness:
  no durable bootstrap worker, authenticated owner probes, owner-specific
  adapters, or production activation caller is deployed. New organizations
  remain `provisioning` and unroutable.
- Fixed five stale test-fixture calls to the current `createActiveTenantFixture`
  signature. This cleared the tenant-control-plane TypeScript build failure;
  the database-backed full tenant-control-plane suite was not run because it
  requires configured control database URLs.
- Re-ran Terraform formatting and validation (Terraform 1.16.4):
  `fmt -check -recursive` and `validate` passed for disposable, platform, and
  bootstrap-state roots. The destroy lifecycle audit reported green with no
  static findings; 63 mocked teardown cases and 16 disposable Terraform
  Python gate tests passed. These results do not prove AWS permissions or a
  live destroy/inventory run.
- The ordinary Terraform readiness gate remains intentionally closed. The
  deployment contract declares 30 releases and 22 runtime image identities,
  four scheduled shard-maintenance tasks, and one PostgreSQL migration/RLS
  acceptance Job; it does not execute all declared data-service probes or
  web/API/alert/iPhone journeys. There is still no production all-owner tenant
  bootstrap or move controller/receipt path. Do not mark Stage 12 complete or
  apply to AWS on this evidence.
- The full shared Compose gate was left untouched because the existing local
  Docker daemon has active GreenGuard, Stage 11, and three-broker Kafka stacks
  used by background acceptance work. Prior isolated Compose evidence remains
  the last full local-stack run; no shared database or AWS resource was changed
  in this follow-up.

## Additional offline verification — 2026-09-29

- The Terraform-to-Argo-to-Helm shard-secret path was checked through the
  projector application contract. The test parses Terraform's release mapping,
  checks runtime registry env names and secret mounts, verifies Argo's merged
  `valuesObject`, fail-closed routing, RDS CA Secret/key path, and read-only
  registry access. Secret mode is `0440` to match UID/GID 101 and `fsGroup`
  101. The focused Ruby test and `scripts/helm-validate.sh` passed; 28 scoped
  shard/runtime-secret tests passed. This is a rendered contract simulation,
  not a live pod read test. Terraform is not available in the current shell;
  the preceding Terraform 1.16.4 fmt/validate result is recorded above.
- Tenant-move and Read API freshness unit suites passed 31/31 and 39/39.
  They exercise fake pools/pure logic. There is no production all-owner
  migration caller or set of adapters for the nine owners; cutover remains
  fail-closed without trusted owner receipts. These tests do not prove a live
  cross-shard move, actual lease drain, old-writer rejection, or replica lag
  behavior against PostgreSQL/Redis.
- The deployment/live-acceptance test group passed 47/47, Compose isolation
  wrapper tests passed 3/3, and Ruby contract readiness passed 3 runs/11
  assertions. The contract checker still blocks certification without signed
  live evidence, and the declared data probes/web/API/alert/iPhone journeys
  are not all executed by the migration Job.
- The full tenant-control-plane `npm test` attempt fails because it starts
  database-backed suites without `CONTROL_DATABASE_URL` and
  `CONTROL_DIRECT_URL`. The TypeScript build and isolated bootstrap protocol
  tests passed, but no production owner bootstrap adapters/caller exist and
  new first-admin enrollments remain `provisioning`.
- A full Stage 12 Compose verify/smoke was not rerun: `docker ps` confirmed
  active GreenGuard, observability, Stage 11, and three-broker Kafka stacks
  belonging to existing background work. The isolated wrapper tests pass, but
  the latest full-stack execution evidence remains the earlier isolated run.
- Rechecked the current disposable Terraform root with the official
  `hashicorp/terraform:1.16` image, mounting the repository root so its linked
  platform definitions and `infra/gitops` contract files resolve correctly.
  Recursive Terraform formatting check and disposable `terraform validate`
  passed. This remains static validation only; no plan/apply/AWS calls ran.
