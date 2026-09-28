# Stage 11–13 pre-AWS deployment audit

> **Update (2026-09-28):** For the latest offline findings, exact current
> application/test counts, and remaining blockers, see
> [the audit update](STAGE_11_12_13_AUDIT_UPDATE_2026-09-28.md). Historical
> counts and configuration descriptions below reflect earlier audit points.

Status: **open**. This is a source and local-evidence audit, not an AWS or
physical-iPhone acceptance record. No real `terraform apply` is authorized by
this record. The deployment gap register is in
[`docs/AWS_ONE_COMMAND_DEPLOYMENT.md`](../docs/AWS_ONE_COMMAND_DEPLOYMENT.md).

## Evidence boundaries

| Area | Verified locally in the repository | Required before the user's end-to-end milestone |
| --- | --- | --- |
| Stage 11 observability | Local OTel/Prometheus/Grafana/Loki/Tempo profiles, synthetic rules/rehearsals and selected live local trace/log links are recorded in the [Stage 11 plan](../docs/STAGE_11_PLAN.md). A bounded, digest-pinned disposable collector/backend Argo child renders offline, and Terraform values enable OTLP/HTTP for seven verified runtimes plus namespaced Prometheus pod discovery. | Supply verified images/admin Secret and prove OTLP delivery, Istio scraping, Grafana access, real web/phone/event/database/alert journeys, approved SLOs and alert routing under representative load. |
| Stage 12 infrastructure | [Terraform static evidence](STAGE_12_TERRAFORM_STATIC.md) and [disposable root evidence](STAGE_12_DISPOSABLE_TERRAFORM.md) cover syntax/synthetic planning. The disposable root validates private RDS/S3, CloudFront/WAF/ALB, Cognito, EBS CSI and seven locally archived controller charts with checked SHA-256 locks offline; Argo renders 21 digest-pinned runtime Applications, data, observability, conditional PgBouncer/topic/Connect children, RDS bootstrap and a deliberately blocking migration gate. | One authenticated plan must include all stores, secret materialization, executable migrations, live controller and workload health, actual app values and teardown ownership. It currently does not. |
| Stage 12 workloads | [Helm evidence](STAGE_12_HELM_BASELINE.md), [runtime deployment inventory](../infra/gitops/RUNTIME_DEPLOYMENT_INVENTORY.md) and [local gate](STAGE_12_LOCAL_GATE.md) cover render, selected fault tests and base Compose verify/smoke. All 21 release profiles, 15 service links and 21 in-cluster data NetworkPolicy links now render offline. Terraform configures the VPC CNI add-on for policy support with an exact operator-supplied version. | Install the exact immutable images and every required service, prove probes, migrations, VPC CNI policy enforcement, external database/identity/provider egress, actual mesh access and app flows in a disposable cluster. |
| Stage 12 release/security | Static GitOps, admission, image-inventory and CI definitions exist. CI digest assembly and GHCR-to-ECR promotion have offline valid/reject fixtures. | Publish/sign and promote images in a real account, prove EKS pulls them, install Argo CD/Rollouts, Kyverno and runtime detection; prove bad manifests rejected and a failed canary rolled back. |
| Stage 12 availability/DR | Local HPA/KEDA render, scheduling policy, resource checker and isolated Postgres restore evidence exist. | Install controllers and data owners, measure node/backlog scaling, zone and failure recovery, all-store restore, cost alerts and complete teardown. |
| Stage 13 capacity/resilience | A [scale model](../docs/SCALE_AND_PRODUCTION_READINESS.md), [Stage 13 acceptance plan](../docs/STAGE_13_PLAN.md), [chaos test inventory](../tests/chaos/README.md) and local Stage 12 resilience checks exist. | Agree on a bounded disposable-cell workload, then run load, soak, queue-backlog, node-loss, broker/store-fault and recovery exercises against the deployed cell. The 10-million-user target is not certified. |
| Web and iPhone | Dashboard/mobile OAuth clients, mobile PKCE/Keychain/URL callback (including cold-start recovery), local BFF tests, opt-in Cognito access-token validation and a guarded first-admin enrollment helper exist. Terraform emits public web/mobile configuration for AWS-owned HTTPS names and renders Cognito settings into Argo releases. | Populate and sync runtime secrets, prove reachable ingress targets, real IdP users and tenant memberships, web callback and build settings, iPhone signing/install, login and alert read/ACK/live-update acceptance. |

The [Stage 12 plan](../docs/STAGE_12_PLAN.md) remains in progress, and
[`docs/MILESTONES.md`](../docs/MILESTONES.md) still records Stage 13 as planned.
Existing local successes are not evidence that `terraform apply` brings up the
whole platform or that `terraform destroy` leaves no chargeable resources.

## Pre-AWS release gate

1. Check code and image inventory for every required runtime, store and
   controller. Require a single accountable owner for each AWS resource.
2. Complete Terraform ownership and an offline plan with no missing runtime,
   identity or edge layer. Resolve the private EKS API access path.
3. Run repository verification, service-specific suites, chart validation,
   Terraform validation, security/static checks and code review on the final
   scoped changes. Record commands, exit codes and the tested commit.
4. Review a real, guarded `terraform plan` in the selected non-production
   account and region. Do not run apply until the pre-AWS gate is green.
5. After apply, capture live health, web and physical-phone OAuth/API journeys,
   Stage 11–13 measurements and a destroy/inventory report. These cannot be
   pre-certified offline.

The current codebase has no complete Stage 13 live acceptance evidence or
complete one-command application deployment. This audit must stay open until
the corresponding implementation and results are linked here.

## Local checks on 2026-09-27

These checks ran in the shared working tree, which still contains other
in-progress changes. They are not a clean-commit CI run or an AWS test.
`make verify` and `make coverage` used the existing isolated
`greenguard-stage12` Compose project and its 55433/56433 loopback database
ports; the original `greenguard-dev` database was not used.
The isolated `greenguard-stage12` containers and network were stopped after
the checks with `docker compose ... down` without deleting named volumes.

| Command | Result | Limit |
| --- | --- | --- |
| `make COMPOSE='docker compose -p greenguard-stage12 --env-file .env -f infra/compose/compose.yaml -f infra/compose/stage12-isolated.override.yaml' verify` | Exit 0 after the control-plane, Sonar BUG and new-code style fixes: migrations, risk tests, workspace format/lint/typecheck/tests, Go checks and builds passed | Does not start Kafka, Cassandra, OpenSearch or AWS; rerun after any further source edit |
| `make COMPOSE='docker compose -p greenguard-stage12 --env-file .env -f infra/compose/compose.yaml -f infra/compose/stage12-isolated.override.yaml' coverage` | Exit 0 after the latest application-source edits: repository coverage command produced Sonar reports | Some opt-in live suites remain skipped; later chart edits are covered by separate static checks |
| `make COMPOSE='docker compose -p greenguard-stage12 --env-file .env -f infra/compose/compose.yaml -f infra/compose/stage12-isolated.override.yaml' smoke` | Exit 0 after the latest application-source edits: live DB readiness, unavailable DB 503, application-role limits and cross-database denial | Health/security smoke only; no Kafka, cloud, web or phone journey |
| `npm run test -w @greenguard/dashboard` | Exit 0: 19 files, 78 tests passed after the Cognito scope/config change | Browser against AWS and physical iPhone remain unrun |
| `bash scripts/helm-validate.sh` | Exit 0: dashboard/BFF/runtime profiles and negative fixtures passed | Render/lint only; no cluster rollout |
| `bash infra/gitops/disposable/cassandra-chart/check-offline.sh`, `bash infra/gitops/disposable/mqtt-chart/check-chart.sh`, and hardware worker `go test ./...` | Exit 0: Cassandra default rejects unauthenticated release, Cassandra clients and MQTT worker verify private TLS roots, and MQTT chart rejects missing digest/credentials | Cassandra server CQL auth/TLS and role bootstrap, broker credential provisioning, external sensor reachability, and live storage teardown remain open |
| `ruby infra/gitops/disposable/test-search-application.rb`, `ruby infra/helm/greenguard-opensearch/check-contract.rb`, Python indexer tests and Read API tests | Exit 0: OpenSearch has conditional Argo ownership, digest-only images, custom TLS preflight, scoped role initialization and verified HTTPS clients; synthetic certificates with wrong SAN/key/CA were rejected | Four Secret values, promoted images, Argo health and real OpenSearch startup/security remain unproven |
| `ruby infra/gitops/disposable/test-cassandra-application.rb`, `bash infra/gitops/disposable/cassandra-chart/check-offline.sh`, isolated Cassandra 5 Docker CQL checks | Exit 0: conditional wave-24 Argo child, digest/Secret rejection, verified TLS-only CQL, rotated default admin, schema bootstrap and reader/write role grants passed locally; exact NetworkPolicy egress/ingress is checked | EKS Argo/Job health, Secret issuance/rotation, same-pod in-place data wipe, PVC/EBS cleanup and full history API journey remain unproven |
| `python3 -m unittest infra/gitops/disposable/test_seed_generated_secrets.py infra/gitops/disposable/mqtt-chart/test_check_secret.py` | Exit 0: guarded RDS/Grafana password seeding, CDC credential derivation and strict MQTT certificate/ACL validation pass offline | Runtime service, provider, device and user credentials still require source values and live reconciliation |
| `ruby infra/gitops/disposable/check-contract.rb` | Exit 0: 21 releases, 20 images, seven explicit blocking gaps | Structural check; `--ready` intentionally fails until deployment prerequisites are implemented |
| `terraform -chdir=infra/terraform/disposable fmt -check` and `validate` (repo-local Terraform 1.16.4) | Exit 0 after the edge/data/identity/CSI merge | No authenticated AWS plan or provider-side resource creation |
| `ruby infra/gitops/disposable/check-contract.rb`, `check-controllers.rb`, `check-application-tree.rb`, `check-observability.rb`, `check-rds-bootstrap.rb`, `ruby infra/kubernetes/disposable-data/check-contract.rb`, `bash infra/gitops/disposable/check-target-bindings.sh` | Exit 0: controller inventory, 21 runtime plus data/observability/RDS/migration-gate Applications, five bounded observability components, seven OTLP/HTTP release values and scoped Prometheus discovery, 18 checked data objects, RDS job safeguards and route/data shapes validate | The migration gate deliberately rejects release; `check-contract.rb --ready` and `check-controllers.rb --ready` correctly fail on missing deployment requirements |

A fresh isolated `greenguard-stage12` `make verify` passed after the OpenSearch
client edits settled: migrations, formatting, lint, typecheck, tests and Go
builds completed. A CodeRabbit review of `.github/workflows/ci.yml` reported
zero findings. This is still local and does not exercise AWS, Argo sync or
physical devices.
The broader GitOps CodeRabbit review reported two actionable findings, both
addressed: the secret preflight now checks PgBouncer, CDC and OpenSearch
sources and binds the CDC password to the RDS role; the PostgreSQL 16 RDS
replication membership now grants explicit inheritance. Offline fixtures and
the RDS bootstrap checker pass after those fixes.
The same isolated project passed `make coverage` after these edits; it wrote
coverage reports for SonarQube, but no fresh remote quality-gate verdict has
been recorded. The project containers and network were stopped without
deleting named volumes.

A separate `make verify` against the shared `greenguard-dev` Compose project
did not pass. The local `.env` points to the isolated 55433/56433 ports while
that project exposes 55432/56432. Process-only port overrides advanced through
the Prisma, telemetry, projection, and risk migrations, then the jobs worker
stopped on a preexisting database version 6 with no version 6 migration in the
current tree. This is a local database-state mismatch, not a green rerun or an
AWS result; no shared database volume was reset.
| `ruby infra/gitops/disposable/test-assemble-ci-digests.rb` and `test-promote-images-to-ecr.rb` | Exit 0: exact 20-image digest assembly and signed GHCR-to-ECR promotion reject missing/foreign/mismatched inputs in offline stubs | No real GHCR/ECR copy, signature verification, node pull or deployment occurred |
| `python3 -m unittest infra/gitops/disposable/test_check_secrets_ready.py infra/gitops/disposable/test_sync_secrets.py -v` | Exit 0: fourteen stubbed cases prove account, AWS JSON, required keys, CA, Kubernetes equality, guarded one-shot sync and idempotent ownership | No actual secret value was provisioned or synchronized; source values, rotation and pod restarts remain operator steps |
| `python3 -m unittest infra/gitops/disposable/test_check_live_acceptance.py -v` | Exit 0: six synthetic valid/reject evidence-manifest cases, including account/revision, malformed types, iPhone journey, hashes and path scope | No live journey or AWS inventory has been captured |
| `node --test scripts/verify-migration-url.test.mjs` and `ruby infra/gitops/disposable/check-owner-migrations.rb` | Exit 0: five TLS/URL guard cases and eleven digest-only PostgreSQL owner migration Jobs render | Published digests, real RDS credentials, Argo ordering and live RLS proof remain incomplete |
| `ruby infra/gitops/disposable/check-data-plane.rb` and `test-data-plane-applications.rb` | Exit 0: PgBouncer, 39-topic Kafka inventory and Connect charts plus conditional Argo children render with digest, ordering and reject checks; `--ready` exits 1 as intended | Credentials, connector/schema registration, Kafka authorization and live Kafka/RDS checks remain incomplete |
| `bash infra/terraform/disposable/teardown_test.sh` | Exit 0: 40 guarded teardown/inventory fixtures, including Argo ownership, retained EBS PV IDs across namespaces and destroy retries, partial-apply wrapper ordering, exact RDS/S3/edge inventory and state-output errors | Stubbed AWS/Kubernetes only; no real destroy |
| `bash infra/terraform/disposable/enroll_first_admin_test.sh` | Exit 0: six stubbed Cognito enrollment checks, including account, confirmed user, verified email and trusted subject | No real Cognito user or tenant membership was created |
| `npm --prefix apps/mobile/shell test -- --runInBand` and `npm --prefix apps/mobile/shell run typecheck` | Exit 0: cold-start OAuth callback, rejected redirects and visible recovery; 59 Jest tests and 2 public-configuration tests passed | No signed iPhone build or real IdP redirect was exercised; shell source remains in the shared uncommitted working tree |
| `make verify` notification-service substep | Exit 0: 126 tests, 120 passed and 6 skipped; includes exact mesh-control-plane URL policy and bounded delivery-drain tests | Mesh enforcement, provider delivery and broker redelivery require live proof |

Terraform 1.16.4 validation of the combined disposable root passed after the
edge/data/identity/CSI merge; this does not establish provider acceptance.
No authenticated AWS plan, apply or destroy was run.

## Local SonarQube quality measurement

The latest isolated `greenguard-audit` Compose scan predates the final
notification and GitOps edits. The scanner container could not follow this
worktree's `.git` pointer to a Git directory outside its mount, so the local
scan used `sonar.scm.disabled=true`; it still analyzed source, imported
coverage, and applied the configured quality gate. Repository coverage was
**83.9%** (line 83.9%, branch 84.2%) on that refreshed scan, above the 80%
condition, with zero security hotspots. The strict overall gate **failed** on
224 total violations (0 in the new-code period) and 0.6% duplicated lines, where
its thresholds are zero. These results describe
the shared dirty tree at that point, not a clean CI commit. A fresh Sonar scan
is still required after the latest edits. The scan does not prove a
remote CI quality gate or any AWS behavior.

The 13 reported BUG/VULNERABILITY findings were inspected. Six actionable
BUGs were corrected in the shared tree: five locale-dependent ordering calls
now use deterministic code-point comparison, and the risk-engine transaction
protocol/test fake accepts the policy ID passed by production code. The six
VULNERABILITY findings inspected in audit storage publish, entitlement
heartbeat, and BFF subscription jitter use `Math.random()` only for timing;
the device import SHA-1 is a deterministic UUIDv5-compatible identifier; and
the notification service's local URL base is used for parsing, not a network
request. Those findings need quality-gate disposition rather than a semantic
change to security-sensitive code. The eight new-code style findings from the
earlier scan were addressed; the subsequent local scan reports zero new-code
violations. The quality gate remains red until the remaining
violations/duplication are resolved.

## Additional fail-closed audits

The disposable Kafka, Schema Registry, RabbitMQ and Redis policy audit found
that the current Kafka and Registry client ports admit every pod in the
namespace while the broker and registry lack application-level authentication.
Existing Kafka clients use plaintext broker addresses. A broker-only SASL/TLS
change would break them. The data contract structural check passes, but its
`--ready` mode rejects this deployment until client credentials, transport and
isolation are integrated and proved.

The standalone connector-registration chart now checks all eight Debezium
configs, RDS hostname substitution, verified PostgreSQL TLS and bounded task
startup. Six offline tests pass. It is intentionally unwired: the Connect
worker still needs an RDS CA mount, a promoted registration image, authorization
and live source-to-topic proof.

The lifecycle audit tests pass (2 tests, 14 assertions), while its `--ready`
mode reports three remaining issues: partial apply before EKS needs state
recovery, pre-destroy permission/inventory checks are incomplete, and raw
`terraform destroy` cannot guarantee a post-destroy inventory. The guarded
wrapper has stub-tested inventory, but no AWS teardown has been run. The MQTT
chart's hardware worker selector was corrected to the release's actual
name/instance and its render checker passes. No AWS apply, destroy, web
journey, or physical-iPhone journey has occurred.

## Kafka and teardown continuation (offline only)

The disposable broker now renders SASL/PLAIN over TLS with KRaft default-deny
authorization and an ACL bootstrap candidate; Schema Registry renders HTTPS
with Basic authentication. Runtime Go, KafkaJS and Python clients have
fail-closed TLS/SASL configuration under `KAFKA_REQUIRE_TLS=true`; local
plaintext remains available only when no security settings are requested.
Terraform's disposable release values mount a CA-only Secret and set the
security protocol; the Secret preflight requires per-release Kafka usernames,
passwords and matching broker JAAS pairs. NetworkPolicy checks now cover 30
data links, including membership-cache Kafka/Redis traffic.

The Connect worker mounts both RDS and Kafka trust roots, uses Kafka
SASL_SSL/PLAIN, and receives a scoped JAAS Secret. The topic bootstrap uses
an authenticated private client properties file. The connector-registration
Application is now a wave-24 child with four digest-pinned data-plane image
inputs; its bounded Job injects verified RDS TLS and, for the Avro contacts
connector, Registry HTTPS Basic credentials and CA trust. The six connector
registration tests and data-plane Argo/chart checks pass. These are render
and local parser checks, not broker/connector execution proof. Registry/ACL
startup ordering, live topic/subject creation, task health, and source-to-topic
flow remain open.

The disposable destroy wrapper now recovers the cell identity from state when
an apply stops before EKS, records an empty PV inventory when the cluster is
confirmed absent, and preflights inventory/KMS read permissions before
cleanup. The offline teardown suite passes 44 stubbed cases. Raw `terraform
destroy` still cannot guarantee the requested post-destroy AWS inventory;
`destroy-verified.sh` is the only verified operator sequence. No real AWS
plan/apply/destroy or physical-iPhone test has run.

A follow-up review found a wave deadlock: Schema Registry could not become
healthy before the wave-12 ACL Job. The Registry Service/Deployment is now a
separate conditional wave-13 Application, while wave 10 owns the broker and
wave 12 owns ACL/topic bootstrap. The Argo tree and data-plane checks reject
Registry in wave 10. This proves the rendered order only; live Argo health and
broker authorization still need acceptance. The reviewer also found an
AvroConverter Registry credential/trust gap and two teardown preflight gaps;
those were fixed and their offline checks pass. The latest local checks include
44 teardown fixtures, 31 secret/registration fixtures, all affected Go module
tests, all-workspace TypeScript typecheck, Kafka security parser tests,
notification tests, Helm validation, Terraform validation and actionlint.

The isolated shared Compose verification subsequently completed with exit
status 0 using `make COMPOSE='docker compose -p greenguard-stage12 --env-file
.env -f infra/compose/compose.yaml -f
infra/compose/stage12-isolated.override.yaml' verify`. This exercised the
local PostgreSQL/PgBouncer migrations and the repository's service test and
build gate. The isolated Compose containers and network were then stopped
without deleting volumes. This is local verification only; it does not prove
AWS deployment, live mesh/data-service interoperability, public HTTPS login,
or physical-iPhone acceptance.

## Release, mobile tenancy, MQTT, and clean-checkout continuation

The mobile Cognito flow now resolves a no-tenant access token through the
BFF's authenticated `session` query before opening tenant-scoped caches or
replaying queued ACKs. It binds the confirmed subject/tenant scope to the
Keychain session, rejects identity mismatch, and rechecks on refresh. The
mobile core suite passes 54 tests and the iOS shell typecheck passes. Real
hosted login, tenant switching and ACK behavior on a physical iPhone remain
unproved.

CI now checks that every exact signed GHCR digest can be pulled anonymously
before publishing Terraform release inputs. Only 9 of 20 existing `latest`
package URLs passed a read-only anonymous probe; this is not proof for the
release digests and currently blocks the direct-GHCR single-apply route. ECR
promotion after Terraform creates repositories has an apply-order cycle; it
has not been integrated into one apply. The image gate must pass on all exact
release digests before that route is used.

The private MQTT broker is now a conditional, digest-pinned wave-11 Argo
child. The hardware worker receives a CA-only mount and TLS credential
contract, with an exact NetworkPolicy edge and a single stable client ID per
Recreate rollout. Terraform, Argo, Helm, Secret and network render checks
pass offline. Broker authentication, approved device credentials and ACL,
durable storage, external device DNS/ingress and real firmware traffic remain
live acceptance work. The iPhone uses the HTTPS BFF, not this MQTT endpoint.

The shared working tree previously had over 1,800 untracked files; the passing
local gate therefore did not prove clean-checkout reproducibility. Mobile/iOS,
Read API, dashboard, and shared membership/entitlements/flags/audit workspace
source have now been scoped into commits. Remaining dirty modules and a clean
checkout build still need review. The latest combined Helm, Argo application
tree, data-plane and `git diff --check` checks pass on the current tree.

A later fresh `git archive HEAD` passed offline `npm ci --ignore-scripts`
and `npm run typecheck --workspaces` across all 19 workspaces after the
mobile, dashboard, Read API, tenant control plane, billing, OIDC, shared
packages, read model and event contracts were committed. Go modules also
build from an archived checkout; five previously failing module test runs
needed event schema files that have since been committed. A clean all-service
test with its Compose database environment and clean deploy build is still
unproved. The worktree retains substantial other Stage 11–13 changes, so a
fresh archive typecheck alone does not establish deployability.

The subsequent source audit committed the BFF, device, workflow-alerts,
notification, hardware and EventBridge runtimes and migrations. A clean
archive builds the four TypeScript services, all ten audited Go modules pass
their tests, and search-indexer passes 22 tests. EventBridge passes six tests
in an isolated venv with its pinned requirements. Fresh-checkout verification
found and fixed missing notification auth dependency builds, missing linked
documentation, and a lint error in the mobile scope regression test.

The isolated Compose rehearsal also found that a missing generated PgBouncer
user list became an empty Docker bind-mount directory. Compose now uses
`create_host_path: false` for that credential file. The archive rehearsal
receives the existing local `.env` and matching generated user list as
restricted local inputs; neither is committed. This setup does not provide
AWS secrets or live authentication evidence. Latest independent checks pass:
44 teardown stubs, 32 release/Secret fixtures, six live-evidence checker tests,
Kafka runtime render checks, and Terraform fmt/validate.

The committed-source Compose gate subsequently passed with exit status 0 in
`/tmp/greenguard-clean-gate-nlc_8ooi`, exported from Git and updated only with
the committed fixes above. It ran `npm ci --ignore-scripts --offline`, then
the isolated `make verify` sequence with matching local `.env` and generated
PgBouncer credentials: migrations, 89 risk tests, formatting/lint/typecheck,
workspace tests, contract checks, Go vet/race tests and final builds completed.
The isolated containers/network were stopped without deleting volumes. The
run log is `/tmp/greenguard-clean-gate-nlc_8ooi-verify.log`; it is local evidence,
not AWS or full Kafka/Cassandra/OpenSearch integration acceptance.

The reviewed EventBridge Pod Identity trust now scopes the role to the exact
cluster ARN, namespace and service account request tags, following the AWS
Pod Identity trust/session-tag contract. Terraform validation passes; actual
STS credentials and EventBridge delivery still require EKS acceptance.
