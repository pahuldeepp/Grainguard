# Stage 12 consolidated local gate — 2026-09-27

Stage 12 remains **in progress**. The local/static sub-slices of 12.8, 12.9 and
12.12–12.14 passed the checks below. This record does not qualify CI publication,
cluster admission/rollout, cloud deployment, production capacity, or disaster
recovery objectives. It supplements the existing slice records rather than
reclassifying their historical runs.

## Scope and execution

Commands ran in the existing repository checkout with its pre-existing changes
preserved. The full `make verify` and `make smoke` targets ran after local
bootstrap. They used a separate Compose project (`greenguard-stage12`), fresh
named Postgres storage, and alternate loopback ports 55433/56433. The older
`greenguard-dev` database volume was not reset. During the initial attempt,
`make verify` applied the pending inventory, alerts, and risk migrations to
that existing database before finding its Jobs migration ledger at version 6,
ahead of this checkout's version 5. No data was deleted; subsequent full-gate
runs used only the isolated project. The existing project remains available.

The isolated `make verify` ran all repository target steps: planning gate,
Postgres/PgBouncer startup, service migrations, 88 Risk tests including live DB
tests, workspace formatting/lint/typecheck/tests, Go vet and race suites, and
production builds. `make smoke` started Telemetry Ingest and Device Service as
local processes and checked readiness against the isolated databases, failure
readiness for unavailable databases, runtime-role limits and cross-database
denial. Its smoke script now requests free loopback ports to avoid collisions
with other local integration runs. Raw output is retained below. Optional
Kafka/CDC, Cassandra, Elasticsearch, AWS, and Kubernetes suites were not
started by these two Make targets; skipped or infrastructure-dependent checks
remain pending. No cluster/cloud API, apply or deploy command ran.

## Commands and results

Commands are relative to the repository root unless the table names a directory.
Full retained stdout/stderr is linked for each check.

| Command | Result | Output |
| --- | --- | --- |
| `python3 scripts/check_plan.py` | Exit 0: 368 catalog/disposition entries; 141 unique coverage rows; component READMEs and local links pass | [Initial output](stage12-local-gate-2026-09-27/plan-initial.log), [final output](stage12-local-gate-2026-09-27/ownership-plan-final.log) |
| `bash scripts/helm-validate.sh` | Exit 0: dashboard/BFF, ten HTTP profiles and three worker profiles; structured scaling, replica ownership, PDB, grace, scheduling and expected drift rejection; digest, mesh/OTel, ingress and canary renders | [Helm output](stage12-local-gate-2026-09-27/helm.log) |
| `ruby scripts/resource-governance-check.rb --self-test` | Exit 0: chart resource/replica bounds, narrow Terraform inputs/wiring, supported KEDA fixture, invalid resource/HCL/node/budget rejection | [Governance output](stage12-local-gate-2026-09-27/governance.log) |
| `npm run test -w services/bff` | Exit 0: 53 tests passed, none skipped; local build uses installed dependencies | [BFF output](stage12-local-gate-2026-09-27/bff.log) |
| `npm run test -w services/gateway` | Exit 0: 10 tests passed, none skipped; stalled provisioning POST completed in the bounded test and made one upstream attempt | [Gateway output](stage12-local-gate-2026-09-27/gateway.log) |
| `go test -race . -run 'TestBindingConsumer(RetryAndCommitFrontier\|ExhaustionAndPermanentFailuresNeverCommit\|RetryCancellationAndClassification)$' -count=1 -v` in `services/telemetry-ingest` | Exit 0: three selected retry/frontier/cancellation cases passed in 1.559s | [Telemetry race output](stage12-local-gate-2026-09-27/telemetry-race.log) |
| `go test -race ./cmd/worker -run 'Test(RunRequiresDatabaseAndBroker\|RunWorkers\|MaintainMQTTConnection\|SubscribeAck\|MQTTSubscription)' -count=1 -v` in `services/hardware-service` | Exit 0: nine selected shutdown/subscription/reconnect cases passed in 1.380s | [Hardware race output](stage12-local-gate-2026-09-27/hardware-race.log) |
| `node --test scripts/recovery.test.mjs` | Exit 0: four WAL/checkpoint reset fixture cases passed; injected query/execute functions prevent shared database calls | [Recovery unit output](stage12-local-gate-2026-09-27/recovery-unit.log) |
| `bash -n scripts/stage12-postgres-restore.sh scripts/helm-validate.sh` | Exit 0, no syntax diagnostics | [Shell syntax output](stage12-local-gate-2026-09-27/shell-syntax.log) |
| `ruby -c scripts/resource-governance-check.rb` | Exit 0: `Syntax OK` | [Ruby syntax output](stage12-local-gate-2026-09-27/ruby-syntax.log) |
| `bash scripts/check-image-inventory.sh` | Exit 0: dashboard/runtime Dockerfiles map to CI builds and Terraform ECR inventory; no image build/publication performed | [Inventory output](stage12-local-gate-2026-09-27/image-inventory.log) |
| `bash -n scripts/check-image-inventory.sh scripts/kyverno-validate.sh scripts/falco-validate.sh` | Exit 0, no syntax diagnostics | [Additional syntax output](stage12-local-gate-2026-09-27/additional-shell-syntax.log) |
| `docker image inspect postgres:16-alpine --format '{{.Id}}'` | Exit 0: cached image available | [Image ID](stage12-local-gate-2026-09-27/cached-image.log) |
| `bash scripts/stage12-postgres-restore.sh` | Exit 0: restored tenant fixture and forced RLS match; initial run 5 seconds, final ownership fix rerun 3 seconds | [Initial restore](stage12-local-gate-2026-09-27/restore.log), [final restore](stage12-local-gate-2026-09-27/ownership-restore.log) |
| `python3 scripts/stage12-postgres-restore.test.py` | Exit 0: six isolated Docker fixture regressions pass, including missing image, source/target collision, failure after source creation, readiness failure and success | [Ownership tests](stage12-local-gate-2026-09-27/ownership-regression.log) |
| `bash -n scripts/stage12-postgres-restore.sh` after ownership fix | Exit 0, no syntax diagnostics | [Final shell syntax](stage12-local-gate-2026-09-27/ownership-shell-syntax.log) |
| `make COMPOSE='docker compose -p greenguard-stage12 --env-file .env -f infra/compose/compose.yaml -f infra/compose/stage12-isolated.override.yaml' verify` | Exit 0: complete Make verify target passed on a fresh isolated Postgres volume; includes live DB migration/tests, workspace checks, Go race suites and production builds | [Compose verify output](stage12-local-gate-2026-09-27/compose-verify.log) |
| `make COMPOSE='docker compose -p greenguard-stage12 --env-file .env -f infra/compose/compose.yaml -f infra/compose/stage12-isolated.override.yaml' smoke` | Exit 0: Telemetry Ingest and Device Service readiness, unavailable-database 503s, restricted DB roles and cross-database denial passed | [Compose smoke output](stage12-local-gate-2026-09-27/compose-smoke.log) |
| Read-only inspection of the rehearsal's observed container IDs and volume names, then temporary dump-directory inventory | Both owned IDs and both observed anonymous volumes are absent; no `work/stage12-restore.*` directories remain | [Final cleanup proof](stage12-local-gate-2026-09-27/ownership-restore-cleanup.log) |
| `git diff --check -- scripts/stage12-postgres-restore.sh scripts/stage12-postgres-restore.test.py docs/STAGE_12_PLAN.md evidence/STAGE_12_LOCAL_GATE.md` | Exit 0, no whitespace diagnostics for tracked changes | [Diff check](stage12-local-gate-2026-09-27/ownership-diff-check.log) |

## Restore cleanup correction and proof

The EXIT trap removes only IDs returned by successful `docker run` calls using
`docker rm -fv`. `source_id` and `target_id` start empty and are recorded before
readiness checks; empty IDs are never passed to removal. All subsequent exec/copy
operations also use the owned IDs. This prevents a reused PID/name collision or
missing image from deleting a pre-existing container. Early failure after source
creation removes only the source ID. Docker removes attached anonymous volumes
with these containers; cleanup never enumerates or prunes unrelated volumes.
The temporary dump directory remains covered by the existing EXIT cleanup.

Six deterministic regressions run a temporary copy of the script with fixture
Docker/sleep executables. Source and target name collisions leave the modeled
pre-existing container untouched. Missing-image cleanup makes no Docker removal
call; source setup/readiness failure removes only its successful ID; success
removes both successful IDs with `-fv`. These regressions make no Docker API call.

The final run used cached image
`sha256:721873c34ceb9f8d8fc265984940dc982404c105f19ad51be9fdc5970a6080ea`.
Read-only container inspections during the final rerun captured each ID and
volume mount. After the script exited, exact-ID container/volume inspections
returned the expected absence errors (exit 1). The aggregate verification passed:

- `greenguard-stage12-backup-source-61816` and
  `greenguard-stage12-backup-target-61816` corresponded to observed IDs
  `b48758b0b2f42bc507963dae2e6f495478f806439f638381ca44984352d25da5`
  and `eadfa3b3c1f86a88df8d7075c9fb5b45541ecaf5def8d1b2404ca43b8d3ecbf0`;
  both IDs were absent after cleanup.
- Anonymous volumes
  `5ae10fba49ee23d57d7e02aaee90f56d3fd1a476ef32d677f499d2af8a2ba919` and
  `7f042a851052dd921b480d533f950c4e920fad56a821c17619d0dc23486178f9`
  were absent.
- `docker ps -a --filter name=greenguard-stage12-backup --format '{{.Names}}'`
  returned no containers; temporary dump-directory inventory was empty.

The earlier 5-second run's observation wrapper incorrectly matched only capitalized `No such`;
Docker's volume error uses lowercase `no such volume`. Its aggregate result was
1 despite the resources being absent. The [initial output](stage12-local-gate-2026-09-27/restore-cleanup-initial.log)
is retained. Read-only reinspection with case-insensitive matching produced the
passing initial cleanup proof; it did not rerun or mutate that restore. The final
ownership fix rerun passed in 3 seconds with the IDs/volumes above. Both elapsed
values cover startup/dump/restore/verification and exclude cleanup; neither is
an approved service RTO or a measured RPO. Historical orphaned volumes were not
removed.

## Blocked and intentionally unrun commands

| Command or gate | Observed blocker / reason |
| --- | --- |
| `bash scripts/kyverno-validate.sh` | Exit 127: Kyverno CLI absent ([output](stage12-local-gate-2026-09-27/kyverno-blocker.log)). No install attempted; policy CLI evaluation and API-server rejection remain unverified. |
| `bash scripts/falco-validate.sh` | Exit 127: Falco absent ([output](stage12-local-gate-2026-09-27/falco-blocker.log)). No install attempted; rule validation, real detection events and alert delivery remain unverified. |
| Optional broker/search/history and cloud gates | Not part of the base Compose verify/smoke targets. Kafka/CDC, Cassandra, Elasticsearch, AWS, and Kubernetes integrations still require their respective local services or owned staging environment. |
| Terraform validate/plan | Terraform is absent in this environment. The Ruby node-input check is narrow source validation, not Terraform parsing/provider validation, an authenticated plan, or applied bounds. Historical synthetic-plan evidence is not replaced by a new run. |
| Kubernetes rollout, admission, mesh, autoscaler, drain/failure and canary rollback | No disposable target is supplied/owned for this gate. `kubectl` is installed but no cluster API was called; `kind` is absent. Controllers, capacity, image digests, issuer/ingress and provider inputs remain required. |
| Remote scans, image/SBOM/provenance/signature publication and staging/cloud acceptance | Remote CI and provider environments were not used. No cloud credential/account/backend ownership or approved budget is supplied. |
| Actual owner-store recovery and live database/broker tests | Actual service databases, broker state and backup/recovery targets were not exercised. WAL/reset/replay scripts ran only through deterministic unit fixtures. |

## Infrastructure-dependent acceptance retained

| Slice | Pending acceptance |
| --- | --- |
| 12.1–12.2 | Disposable cluster rollout/smoke, probe behavior, network policy and real mesh/OTel reachability. Dashboard 12.1 is complete only for its existing offline scope. |
| 12.3 | Deliberately vulnerable scanner gates executed remotely; published immutable images with retained SBOM/provenance and verified signatures. Source inventory checks do not prove publication or scanning. |
| 12.4 | Managed data services, actual account/backend ownership and installed-provider authenticated Terraform validation/plan; cloud deployment requires its own authorized workflow. |
| 12.5 | Secrets Manager/External Secrets sync/rotation and live workload identity access/denial proof. |
| 12.6 | Argo CD digest promotion and a real failed metric analysis causing disposable canary rollback. |
| 12.7 | mTLS, AuthorizationPolicy, mesh traffic behavior, cloud edge/WAF/DNS/TLS and staging core flows. |
| 12.8 | Real metrics/KEDA controllers, broker credentials, CPU/backlog load, scaling bounds and live scale-to-zero, pending-pod capacity via Karpenter without critical-service disruption. |
| 12.9 | Real PriorityClass/eligible zones, multi-AZ/zone/node failure, PDB-enforced drain/rescheduling, broker persistent redelivery and durable worker checkpoint/shutdown recovery. |
| 12.10 | Kyverno CLI evaluation and deliberately invalid manifests/subresource updates rejected by a disposable API server. |
| 12.11 | Falco rule-engine validation, controlled process/network detection and actionable alert delivery. |
| 12.12 | Disposable mesh route-specific retry/per-try/overall timeout/outlier-ejection, edge/WAF limits, consistent idempotency keys and one durable side effect under real database/broker partitions. Per-ReadClient breaker state is not shared across instances/replicas. |
| 12.13 | Approved/measured RPO/RTO for actual owned stores, managed/PV backups, PITR, Kafka/Cassandra recovery, encryption/key recovery, regional failover and monitoring. |
| 12.14 | Approved caps and final deployment overrides; named budget owners/contacts, amount/currency, scope/tags and provider alerts; measured capacity, safe drain/consolidation/scale-down, forecast/actual spend and warning/escalation delivery before the spend limit. The local checker excludes injected sidecars, surge/init overlap and non-workload/cloud overhead and is not automatically a CI/admission enforcement gate. |
| 12.15 | End-to-end staging core flows, operator recovery/rollback evidence and review of all Stage 12 coverage rows. |

Slice detail remains in [local resilience](STAGE_12_RESILIENCE_LOCAL.md),
[local recovery](STAGE_12_BACKUP_RESTORE_LOCAL.md),
[scaling/scheduling](STAGE_12_SCHEDULING_STATIC.md), and the
[resource governance runbook](../docs/runbooks/cost-resource-governance.md).

## Final review fixes and rerun — 2026-09-27

The post-gate source review found and this rerun addressed several local
reliability gaps: the BFF image now includes its membership-client workspace;
BFF subscription setup fences stale concurrent requests, retains hints received
during reads, caps active connections and concurrent polls per replica, jitters
fallback polls, and recovers readiness on Redis Cluster events; alert
acknowledgements use an independent rate bucket; path IDs reject dot segments;
subscription setup is rate-limited and bounded; WebSockets require a timely
initialization and receive ping/pong liveness checks; idempotency keys and
notification rows are validated before use; and notification-owner network
failures map to a controlled unavailable result.
The gateway now pipes upstream responses with error/close propagation, uses a
true client idle timeout for upgraded sockets, and reports correct HTTP reason
phrases. MQTT ack-triggered reconnects use bounded backoff. Offline image and
Kyverno checks fail closed, and the PostgreSQL rehearsal waits for the database
itself to become queryable before proceeding.

Latest rerun outputs:

| Command | Result | Output |
| --- | --- | --- |
| `npm run test -w services/bff` | 61 passed, none skipped | [BFF final output](stage12-local-gate-2026-09-27/bff-final.log) |
| `npm run test -w services/gateway` | 10 passed, none skipped | [Gateway final output](stage12-local-gate-2026-09-27/gateway-final.log) |
| `go test -race ./...` in `services/hardware-service` | All packages passed; worker tests include reconnect backoff | [Hardware final output](stage12-local-gate-2026-09-27/hardware-final.log) |
| `bash scripts/helm-validate.sh` | All chart/profile renders and negative scheduling/autoscaler fixtures passed | [Helm final output](stage12-local-gate-2026-09-27/helm-final.log) |
| `ruby scripts/resource-governance-check.rb --self-test` | Static caps and valid/invalid fixtures passed | [Governance final output](stage12-local-gate-2026-09-27/governance-final.log) |
| `bash scripts/check-image-inventory.sh` | All tracked runtime Dockerfiles map to publication and Terraform inventories | [Image inventory final output](stage12-local-gate-2026-09-27/image-inventory-final.log) |
| `docker build --pull=false -f services/bff/Dockerfile -t greenguard-bff:stage12-local .` | Image build passed with cached pinned base; no app deployment/run | [BFF image build output](stage12-local-gate-2026-09-27/bff-image-build.log) |
| `bash scripts/stage12-postgres-restore.sh` | Cached-image restore and RLS check passed | [Restore final output](stage12-local-gate-2026-09-27/restore-final.log) |
| `python3 scripts/stage12-postgres-restore.test.py` | Six cleanup/ownership regressions passed | [Restore ownership final output](stage12-local-gate-2026-09-27/restore-ownership-final.log) |

The base Compose-backed `make verify` and `make smoke` now pass against isolated
Postgres/PgBouncer storage. This remains local acceptance: Kubernetes rollout,
mesh, autoscaler/canary, admission/runtime-security, cloud, optional broker/search
integrations, and Stage 12.15 staging E2E acceptance remain pending as listed
above. Stage 12 is still in progress.

## Isolated rerun — 2026-09-28

The corrected gate wrapper was run from a fresh scratch environment
(`greenguard-stage12-c261b0de4f`) using:

```sh
node scripts/stage12-compose-gate.mjs run
```

It applied the service migrations, ran `make verify`, then ran `make smoke`.
The full verify completed successfully, including workspace formatting, lint,
typechecking, application tests, and Go format/vet/race checks. Risk Engine
reported 97 passing tests and one optional isolated-shard test skipped. The
workspace results included the tenant-control-plane move-boundary suite after
correcting its fixture to restore the target shard's original offline state.
The smoke result was:

> PASS: live database readiness, unavailable database returns 503, application
> database privileges and cross-database denial.

The wrapper removed the exact run's containers, network, and database volume and
reported `PASS: isolated Compose verification and smoke; project and volume
removed.` Separate static contracts also passed: Stage 12/13 harness tests (8),
four-shard Terraform/runtime contracts (5), and lifecycle audit tests (8 runs,
70 assertions). Terraform 1.16.4 `fmt -check` and `validate` passed for the
bootstrap-state, platform, and disposable roots; this was offline validation,
not an AWS plan.

This is not a complete-stack Compose E2E: the smoke starts Telemetry Ingest and
Device Service against isolated PostgreSQL/PgBouncer. Kafka, Redis Cluster,
Cassandra, OpenSearch, Dex/OIDC, Argo CD, web, and mobile were not all running
together. Optional broker, real Redis, and real four-shard acceptance cases were
skipped when their dedicated endpoints were absent. The Stage 13 harness only
validates bounded local manifests and explicitly does not certify capacity or
chaos behavior.

## Remaining pre-AWS blockers confirmed — 2026-09-28

- Terraform's normal disposable readiness precondition still blocks a normal
  `plan`/`apply` until tenant enrollment, bootstrap/data acceptance, live secret
  synchronization, and audit-export acceptance are complete. No apply was run.
- Four RDS shard bundles and runtime registries are modeled, but control-plane
  bootstrap still seeds the legacy state (only `s1` active). No guarded deployed
  activation path or tenant-created-event provisioner installs tenant ownership
  in every owner database. Enabling greenfield mode alone would leave all shards
  unavailable to onboarding.
- There is no trusted all-owner tenant-move coordinator. Only Risk, Inventory,
  and Telemetry have local adapters; other owner effects lack operation-bound
  receipts and migration acceptance. The new deny-by-default database migration
  prevents the untrusted control role from forging receipts or completing a
  cutover. Actual shard movement therefore remains blocked safely.
- `saga-worker` now has loopback-only liveness/readiness based on consumer
  assignment and worker-loop progress. Runtime behavior on Kubernetes remains
  unproven.
- Destruction must use `infra/terraform/disposable/destroy-verified.sh`; raw
  `terraform destroy` has no guaranteed final-inventory hook. The verifier's
  inventory scope is the configured account and region plus named global
  resources, not an exhaustive scan of every account/region.
- OAuth/OIDC callback configuration exists, but real-user tenant enrollment,
  deployed HTTPS login, browser/mobile sign-in, and physical-iPhone API flows
  still require an owned AWS environment and live acceptance.

No AWS APIs, production resources, Terraform apply/destroy, or shared database
state were touched during this rerun.

## Isolated rerun after Stage 12 integration fixes — 2026-09-28

The isolated gate was repeated after adding canonical control-plane token
propagation and tenant bootstrap/move preflight contracts:

```sh
node scripts/stage12-compose-gate.mjs run
```

The wrapper used fresh Compose project `greenguard-stage12-d73a41088f`, ran the
entire `make verify` target and runtime smoke, then removed that project's
containers, network, and Postgres volume. `make verify` passed workspace
formatting, lint, typechecking, application tests, migration/build steps, and Go
format/vet/race suites. Optional live tests requiring external Kafka, Redis,
search, cloud, or a separately configured four-shard endpoint remained skipped.
The smoke passed live database readiness, unavailable-database 503 handling,
restricted application database privileges, and cross-database denial.

Additional focused checks after those edits passed: tenant bootstrap and move
preflight tests (7), canonical lookup-token and Secret readiness tests (32),
teardown lifecycle audit (9 runs / 74 assertions), Terraform formatting for
`runtime-secrets.tf`, and offline validation of the disposable Terraform root.
OIDC identity contract tests passed (7 runs / 127 assertions), and mobile tests
passed (7 suites / 59 tests plus 4 config tests). The tenant-control-plane test
script was also invoked directly without its required `CONTROL_DATABASE_URL`
and `CONTROL_DIRECT_URL`; that invocation failed for missing environment
configuration. The complete suite passed inside the isolated Stage 12 gate.

This remains a local acceptance gate. It does not deploy the full Kafka/Redis
Cluster/Cassandra/OpenSearch/OIDC/Argo/web/mobile stack, nor prove AWS, EKS,
tenant bootstrap, tenant movement, browser login, or physical-iPhone flows. No
AWS APIs, production resources, Terraform apply/destroy, or shared database
state were touched during this rerun.
