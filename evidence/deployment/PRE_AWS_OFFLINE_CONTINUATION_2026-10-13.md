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

## Still not proven / deployment blockers

- Full current-commit CI has not run. The latest available remote run is on an
  older SHA and is summarized above. It does not establish that current-branch
  browser E2E or Sonar passes.
- `make verify` ran locally and passed. A full remote CI run for the current
  branch still has not run.
- The upstream provenance/signature and Kafka/Cassandra vulnerability release
  checks remain unresolved. The latest candidate scan is still red as detailed
  above. No release eligibility or security thresholds were weakened.
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

## Next actionable work

Resolve image provenance/vulnerability findings with verifiable upstream
artifacts, diagnose the CI-only RabbitMQ exit on a non-billed runner, prepare a
fresh isolated local database E2E environment for the placement change, and
reconcile capacity with the quota without dropping required services or
security controls. A cloud deployment remains gated by the user's no-cost
instruction and by real credentials/acceptance evidence.
