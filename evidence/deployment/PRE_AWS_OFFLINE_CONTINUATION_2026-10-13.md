# Pre-AWS offline continuation evidence — 2026-10-13

## Scope and safety

This continuation performed local checks only. It made no AWS API changes,
Terraform apply, ECR publication, GitHub push, or CI dispatch. The AWS CLI
session was expired. No live AWS plan or deployment is evidenced here.

The shared `.coverage` modification and untracked
`docs/CHATGPT_PROJECT_HANDOFF.md` were pre-existing and left untouched. The
shared GreenGuard Compose/database project was not restarted or modified.

## Changes

- Commit `e7f42cc` fixes the local placement authority fixture: it now serves
  the trusted infrastructure tenant that `bootstrapTenantOwnership` seeds in
  databases. A regression test checks the tenant, shard, incarnation, epoch,
  active state, and lease expiry.

## Checks run

- `node --test scripts/placement-fixture.test.mjs scripts/rabbitmq-start.test.mjs`
  — 10 passed.
- `python3 -m unittest discover -s infra/terraform/disposable -p 'test_*.py' -v`
  — 81 passed.
- `python3 -m unittest discover -s infra/gitops/disposable -p 'test_*.py' -v`
  — 217 passed.
- `python3 -m unittest infra/gitops/disposable/mqtt-chart/test_check_secret.py -v`
  — 8 passed.
- `make image-inventory` — passed; required runtime, migration, and tool images
  are mapped to CI builds and immutable ECR repositories.
- `make bootstrap && make verify` — passed with exit code 0 in a detached,
  throwaway worktree at commit `2d27c9c`, with a unique Compose project,
  generated local-only credentials, and its own PostgreSQL volume. This
  covered database migrations, database-backed service suites, frontend and
  backend formatting/lint/typecheck/build, Go vet/race suites, and the
  repository verification checks. The opt-in live Kafka/Redis/object-store
  cases reported as skipped remain unproven. The test containers, network,
  volume, generated credentials, and worktree were removed afterward; the
  shared application database was not used.
- `make bootstrap && make smoke` — passed in a second isolated detached
  worktree and database project. Real telemetry-ingest and device-service
  processes reported ready against the test database, both returned 503 for
  intentionally unreachable databases, and the smoke check verified that
  runtime database roles are unprivileged and cannot connect to another
  service database. That worktree, containers, network, volume, and generated
  local credentials were removed afterward.
- `terraform fmt -check -recursive infra/terraform` — passed.
- `terraform init -backend=false -input=false -lockfile=readonly` and
  `terraform validate` passed for `bootstrap-state`, `platform`, and
  `disposable`. These commands used no backend and contacted no AWS account.
- RabbitMQ started healthy in a uniquely named local Compose project with host
  ports disabled. `rabbitmq-diagnostics -q check_port_connectivity` passed.
  Only that temporary project and its volume were removed afterward.
- `make stage07-e2e` — passed in an isolated detached worktree at `ed8eb79`,
  with a new PostgreSQL database/volume, unique Compose project, Kafka,
  Debezium Connect, Schema Registry, and MQTT host ports. It passed the
  two-tenant device provisioning and trace checks, duplicate provisioning
  race, SIGKILL/restart at each saga transition, hardware outage/recovery,
  timeout compensation, operator redrive and late-result reconciliation,
  lease takeover with a higher fencing token, and an 8-second Kafka pause with
  successful saga completion. Every duplicate check observed exactly one
  command/result per step and one `device.registered` event. All six CDC
  connectors and the notification Avro schema checks were healthy. The test
  project, containers, network, database/Kafka/MQTT volumes, and generated
  credentials were removed after the run; shared development containers and
  data were not touched.
- The first isolated Stage 07 attempt exposed host URLs hard-coded to the
  shared Schema Registry and Kafka Connect ports. Local endpoint configuration
  is now loopback-validated and host ports are configurable in the Kafka
  Compose overlay; the full Stage 07 run above exercised non-default ports.
- `make bootstrap && make verify` — passed on `ed8eb79` plus the Stage 07
  endpoint changes in a second isolated worktree with a distinct Compose
  project and fresh PostgreSQL volume. This reran migrations, database-backed
  JavaScript/Python suites, TypeScript workspace typechecks, format/lint,
  telemetry sink contract tests, Go vet/race tests, and the production build.
  Explicit opt-in Kafka integration tests remained skipped by the gate; the
  Stage 07 Kafka/CDC/MQTT acceptance above supplies its separate live local
  evidence. The temporary project, volume, credentials, and worktree were
  removed afterward.
- On the exact current release branch HEAD `a004caa`,
  `node scripts/stage12-compose-gate.mjs run` completed successfully. It ran
  the full `make verify` target followed by `make smoke` against a newly
  generated, uniquely named Compose project and PostgreSQL volume. All
  migrations, lint, typecheck, builds, unit/database suites, Go vet/race suites,
  and runtime database readiness/privilege smoke checks passed. The full
  current-HEAD smoke confirmed live DB readiness, 503 for an unreachable DB,
  restricted application DB roles, and cross-database denial. The gate removed
  its containers, network, volume, generated local credentials, and scratch
  workspace on success. Opt-in external-service tests remain separately
  scoped and are not implied by this gate.
- On the same current HEAD, `terraform fmt -check -recursive infra/terraform`
  and isolated `terraform init -backend=false -input=false
  -lockfile=readonly` plus `terraform validate` passed for all three roots:
  `bootstrap-state`, `platform`, and `disposable`. This checks configuration
  without initializing a backend, reading AWS state, or contacting AWS.
- `kyverno test infra/kyverno/tests --require-tests` passed (7/7) using the
  official Kyverno CLI v1.19.1 macOS ARM64 release asset after verifying its
  published SHA256. The binary/archive were extracted in a temporary directory
  and removed after the run; no repo dependency or global installation changed.
- Vendor-image hardening candidate build and scan completed locally. Candidate
  builds retained Kafka 3.9.2 and Cassandra 5.0.9 behavior, and Trivy scanned
  both immutable local image IDs with the current HIGH/CRITICAL fixable policy.
  The policy gate **fails**: Kafka has 21 HIGH and 1 CRITICAL Java dependency
  findings; Cassandra has 17 HIGH and 1 CRITICAL Java dependency findings.
  The locked OS package hardening did not change those bundled Java libraries.
  No vulnerability waiver or release pin change was made. Detailed Trivy JSON,
  database metadata, immutable image inspections, and build logs are retained
  under ignored `.local/vendor-hardening/review-20261013/` for local review.
- The same candidates passed the isolated runtime smoke: Kafka authenticated
  TLS/KRaft, scoped producer/consumer round trip, cross-tenant ACL denial,
  invalid-password rejection, and non-root runtime; Cassandra non-root runtime,
  TLS/authentication and plaintext/CA rejection, scoped read/write and denied
  role, TTL, plus persisted SSTable data through a 5.0.5→5.0.9 single-node
  restart. The smoke explicitly does **not** prove full application CDC,
  multi-node availability, or release security eligibility. The run recorded
  `cleanupComplete: true`; its containers, network, volume, credentials, and
  fixture files were removed. Smoke logs and cleanup receipts remain under
  ignored `.local/vendor-hardening/smoke-20261013/`.
- Read-only review of GitHub Actions run
  [38323425491](https://github.com/pahuldeepp/Grainguard/actions/runs/38323425491)
  on SHA `d7e3079` found four failed jobs and an incomplete quality gate: the
  MQTT secret test, browser E2E, Stage 07 saga E2E, and RabbitMQ startup failed;
  Sonar was cancelled before its result. On the current local branch, the MQTT
  secret suite passes (8/8), Stage 07 E2E has passed as recorded above, and the
  latest isolated RabbitMQ startup in unique Compose project
  `greenguard-rabbit-ci-20261013` passed health checks and was fully removed
  with its unique volume and network. The old run's RabbitMQ container exited 1
  before the then-current job retained container logs; the current startup
  wrapper captures sanitized state/logs on failure. A full current-commit
  browser and remote CI rerun is still unproven. No new GitHub run was
  dispatched.
- The old Stage 08 browser failure showed the interactive-login assertion can
  race the dashboard's silent OIDC session-restore request (`prompt=none`) to
  the same Dex `/auth` endpoint. `scripts/browser-e2e.mjs` previously selected
  the first `/auth` request, while the standalone OIDC browser test already
  intended to select the interactive request. Both now use the shared
  `scripts/oidc-authorize-request.mjs` matcher, which checks the exact issuer
  origin/path and excludes only silent `prompt=none` authorization. Its
  regression suite passed 3/3 cases, including trailing-slash issuer handling
  and wrong-authority rejection; Prettier check passed.
- After that browser-request matcher change, the isolated
  `node scripts/stage12-compose-gate.mjs run` completed with exit code 0 on the
  current working tree. This reran the complete `make verify` and `make smoke`
  sequence against a unique scratch Compose/PostgreSQL environment. All
  service/database tests, builds, formatting/lint/typecheck, Go vet/race
  suites, and database readiness/privilege/cross-database smoke assertions
  passed. The isolated gate removed its containers, network, volume, generated
  local credentials, and scratch workspace. This does not substitute for the
  browser E2E itself or remote CI; those remain unproven.

## Follow-up during this session

- The `greenguard-gha` Lima VM was stopped and the only matching GitHub Actions
  self-hosted runner was offline. It was started locally; no hosted runner was
  selected. CI run [38415012119](https://github.com/pahuldeepp/Grainguard/actions/runs/38415012119)
  began against commit `0d59b57e5da3c158cf32932d7c9a14648591acd8`. Its interim
  results include successful Helm/GitOps contracts and OIDC integration; the
  remaining checks were still queued/running when this note was written.
- AWS login was restored for account `580360261589`. Read-only Service Quotas
  queries in `us-east-2` confirm standard On-Demand EC2 vCPU quota **8** and RDS
  DB-instance quota **40**. Existing request `3993b1908ca34478b81df8116a11b1059gaZ54fV`
  remains `CASE_OPENED`, requesting **32** vCPUs (case `179184870300874`).
- The first live `check-teardown.sh` attempt uncovered a current AWS CLI
  incompatibility: Cognito `list-user-pools` needs `--max-results 60`; `--page-size`
  fails parameter validation. The script and stub regression assertion now use
  `--max-results`; `bash infra/terraform/disposable/teardown_test.sh` passed
  **89/89** checks. A second read-only check reported no GreenGuard cell-owned
  resources in `us-east-2`. The region-wide EBS query returned an empty list; a
  temporary empty PV receipt based on that independent result let the strict
  inventory complete. This does not certify every AWS region or every resource
  in the account.
- PR #19's run `38415012119` passed `make verify`, coverage generation, smoke,
  staging, Helm/GitOps rendering, and OIDC integration. Its Sonar step failed
  before analysis: the native scanner's protected-directory guard rejected the
  runner's group-writable `/home/runner/.cache` (mode `0775`). The scanner guard
  was correct; CI now creates a private per-run scanner home under `RUNNER_TEMP`
  and removes only that explicitly prefixed directory. A regression test covers
  the home override. Targeted scanner tests passed **21/21**, `actionlint` passed,
  and `git diff --check` passed. The old run does not include this fix and is
  still running unrelated integration jobs.
- The Terraform capacity formula's checked-in defaults require **52 vCPUs** for
  managed-node maxima plus the configured DEFAULT-update surge in two AZs
  (before Karpenter capacity); with AI parser nodes enabled it requires
  **64 vCPUs**. Therefore the currently pending 32-vCPU quota request is not
  sufficient for those defaults. The app workload lower-bound analysis also
  remains above 8 vCPUs before several required data/observability workloads.
- An expanded Apache Kafka 4.3.1 source client-suite study remained
  inconclusive: the bounded run hung inside upstream
  `SelectorTest.testConnectionsByClientMetric` on `ServerSocketChannel.accept()`.
  Its uniquely owned container was stopped and verified absent. The source
  distribution build/scan and narrow LZ4/Connect tests do not close the full
  compatibility or release-security gate; production pins are unchanged.

## Still not proven / deployment blockers

- Full CI on commit `7f198aa` and the scanner-home fix has not run yet. Run
  `38415012119` targets older SHA `0d59b57e5da3c158cf32932d7c9a14648591acd8`;
  its positive test results do not prove the latest changes. It does not
  establish that current-branch browser E2E or Sonar passes. The
  authorization-request selection race has a focused regression test and the
  full local verify/smoke gate is green, but the opt-in real browser E2E still
  needs a fresh run.
- The upstream provenance/signature and Kafka/Cassandra vulnerability release
  checks remain unresolved. The latest candidate scan is still red as detailed
  above. No release eligibility or security thresholds were weakened.
- A local evaluation of the Apache Kafka 4.3.1 multi-architecture image
  (`sha256:77e3df9054047a88b520d0cc46e16696d3b22022e1d580aeccd2632df6532837`,
  with amd64 and arm64 manifests) also failed the fixable HIGH/CRITICAL policy:
  Trivy reported 26 HIGH and 0 CRITICAL findings on both architectures. This
  upstream version therefore is not a clean security replacement; no runtime
  pin was changed. The scan used isolated temporary caches which were removed.
- Current quota evidence says the safe workload minimum exceeds the reported
  8-vCPU quota. No workload or security control was removed to force admission.
- The trusted initial production owner payload, deployed user tenant
  membership, and full AWS/OIDC/Stripe runtime secret inputs are not present
  as verified deployment evidence.
- The Terraform disposable root intentionally retains fail-closed readiness
  checks. No Argo/EKS, web/iPhone, service/data-plane, SLO/20K–50K events/sec,
  DR, or post-destroy AWS inventory acceptance has been proven live.
- No AWS resources were created by this continuation. The earlier account
  inventory is historical evidence and must be refreshed after AWS
  authentication is available; this record does not claim the account is
  currently empty.

## Capacity clarification from independent chart audit

- The earlier `minimum-capacity.rb` result of **8.025 vCPU** is only an
  optimistic one-pod-per-release floor. It is not the enabled deployment's
  minimum: it omits chart replica counts and many required platform/data
  services.
- Counting the current 33 app releases at their chart replica defaults gives
  48 application replicas / 5.025 vCPU. Adding the configured 100m Envoy
  request per injected replica and the baseline Kafka, RabbitMQ, and Redis
  stateful workloads yields at least **11.175 vCPU**. Adding the statically
  configured Cassandra, ClickHouse, Kafka Connect, OpenSearch, MQTT,
  PgBouncer, Dex, Schema Registry, and observability requests yields at least
  **14.025 vCPU**. With the enabled AI runtime and synthetic ML components,
  the estimated pod request floor is about **17.7 vCPU**. This still excludes
  EKS node reservations, DaemonSets/add-ons, controllers, ingress, and
  migration/acceptance Jobs, so it is a lower bound, not a node-fit result.
- Therefore the confirmed **8-vCPU account quota cannot fit the enabled
  service set** without reducing enabled workloads or their replica/resource
  requirements. The earlier 52/64-vCPU preflight numbers are configured
  maximum plus upgrade-surge allowances, not steady-state minimums. Karpenter
  has a configured limit of zero by default, so it does not supply extra
  capacity today.
- Do not claim that 20–24 vCPU is sufficient until a rendered scheduling
  simulation includes allocatable node capacity, DaemonSets, controllers,
  ingress, jobs, and upgrade policy. No workload/security controls were
  changed to force a fit.

## Read-only AWS teardown inventory refresh — 2026-10-13

- `aws sts get-caller-identity` confirmed the active session is in account
  `580360261589`. No infrastructure mutation, Terraform plan, or apply was run.
- `check-teardown.sh us-east-2 disposable greenguard-sandbox-cell-1
  580360261589` reported no owned resource; it initially failed closed because
  the post-destroy PV inventory file did not exist. A direct
  `ec2 describe-volumes` query returned **0 EBS volumes** in `us-east-2`.
- Re-running the same scoped inventory with an empty temporary PV receipt
  backed by that zero-volume query passed: **no GreenGuard resources found for
  the disposable cell in us-east-2**. The temporary receipt was removed.
- This is a scoped, read-only check for the named cell/region plus the global
  edge resources covered by the script. It is not an account-wide inventory of
  every region/service, and it is not proof of billing totals or that a future
  `terraform destroy` has been tested.

## CI follow-up — run 38420818770

- The run on remote SHA `19d4ad6` completed with Event backbone, Search/Kafka,
  Redis, Saga, Cassandra, Risk/alert, MySQL CDC, OIDC, Helm/GitOps, image
  inventory, and dependency/IaC scanning green. The required quality gate failed
  only at Prettier for `scripts/sonar-native.test.mjs`; that file is formatted
  locally and the check passes. The Terraform schema tests failed before the
  diagnostic commit was present, so the exact Linux stderr remains unknown.
- Gateway/dashboard browser acceptance found two harness issues: the reload
  assertion required an interactive sign-in even when the browser correctly
  retained the session; and a direct Saga test update supplied tenant context
  but omitted the trusted fixture's shard ID, incarnation, and placement epoch.
  The harness now expects session retention and supplies the complete local
  placement tuple without bypassing the database fence. Four focused Node tests,
  Node syntax checks, Prettier, and `git diff --check` pass locally. The complete
  browser E2E rerun is still pending; these fixes are not called end-to-end
  verified until that gate passes.

## Next actionable work

Resolve image provenance/vulnerability findings with verifiable upstream
artifacts, diagnose the CI-only RabbitMQ exit on a non-billed runner, prepare a
fresh isolated local database E2E environment for the placement change, and
reconcile capacity with the quota without dropping required services or
security controls. A cloud deployment remains gated by the user's no-cost
instruction and by real credentials/acceptance evidence.

## Isolated local Stage 12 Compose verification — 2026-10-13

- `node scripts/stage12-compose-gate.mjs run` completed successfully against a
  uniquely named Compose project and freshly generated test credentials. It did
  not source the shared `.env` or reuse the shared application database.
- The run passed the complete `make verify` suite, including dashboard/mobile,
  tenant-control, billing, alerts/notifications, Read API hot/cold history,
  and Go race/vet/format gates, then built all configured workspaces and ran
  `scripts/smoke.mjs`.
- Smoke evidence: PostgreSQL-backed readiness was live; unavailable database
  readiness returned 503; application-role privileges and cross-database
  access denial passed.
- The gate removed its own Compose containers, network, and Postgres volume and
  reported `PASS: isolated Compose verification and smoke; project and volume
  removed.` No shared Compose project or volume was targeted.
- This local run does not cover the opt-in browser E2E, live AWS/EKS, production
  OIDC/Stripe configuration, real-data ML validation, or production capacity.

## Vendor image hardening candidates — 2026-10-13

- `infra/vendor-hardening/build-and-scan.sh
  .local/vendor-hardening/review-20261013b gg-review-20261013b` built local
  Kafka and Cassandra candidates. `infra/vendor-hardening/test-tooling.py`
  passed 10/10 tests.
- The candidate smoke passed the Kafka authenticated TLS KRaft startup, scoped
  producer/consumer payload round-trip, ACL and cross-tenant denial, and invalid
  password checks. Cassandra passed the 5.0.5→5.0.9 persisted SSTable read,
  scoped writer round-trip, role/password/untrusted-CA/plaintext-CQL denials,
  and TTL expiry. The harness explicitly reports
  `SINGLE_NODE_TLS_SMOKE_PASS`; it does not prove multi-node Cassandra, CDC, or
  the full application.
- Trivy 0.75.0 with vulnerability DB updated 2026-10-13 reported **Kafka: 21
  HIGH, 1 CRITICAL** and **Cassandra: 17 HIGH, 1 CRITICAL**, all in Java
  dependencies. The local rebuild did not resolve the release-blocking findings.
  Its generated findings report and raw scans are under ignored `.local/` and
  were not added to Git.
- Both locally built image digests are **ARM64** (`4260664e…` Kafka and
  `ead41157…` Cassandra). The AWS runtime inventory targets amd64; these local
  images do not prove the amd64 candidate scan or production provenance. No
  image inventory, release pin, CI policy, or AWS resource was changed.

## Fresh self-hosted CI — run 38433935232

- The pushed commit `ea0df388` passed `make verify`, optional AWS-profile
  synthesis, PostgreSQL read-role isolation, `npm audit`, coverage generation,
  smoke, and disposable image staging on the Linux ARM64 runner. Secret
  scanning, dependency/IaC scanning, and MySQL snapshot/CDC integration passed.
- Sonar analysis completed but its quality gate failed. The measured report
  shows **82.7% coverage**, **84.3% branch coverage**, and **0 security
  hotspots**; overall limits failed at **0.9% duplicated lines** (limit 0%) and
  **357 violations** (limit 0%). This is a quality-gate failure, not evidence of
  357 security vulnerabilities. The gate remains enabled.
- The failed run's artifact contains aggregate metrics but not issue locations.
  Commit `45afccf` adds a sanitized rule/severity/file/line summary to the same
  coverage artifact for the next run; it does not alter gate thresholds.
- At the time of this record, Terraform, web E2E, and remaining integration jobs
  had not completed. This run is for `ea0df388`, so it does not verify the later
  diagnostic-only commit.
