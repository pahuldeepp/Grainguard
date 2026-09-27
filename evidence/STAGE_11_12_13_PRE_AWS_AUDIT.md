# Stage 11–13 pre-AWS deployment audit

Status: **open**. This is a source and local-evidence audit, not an AWS or
physical-iPhone acceptance record. No real `terraform apply` is authorized by
this record. The deployment gap register is in
[`docs/AWS_ONE_COMMAND_DEPLOYMENT.md`](../docs/AWS_ONE_COMMAND_DEPLOYMENT.md).

## Evidence boundaries

| Area | Verified locally in the repository | Required before the user's end-to-end milestone |
| --- | --- | --- |
| Stage 11 observability | Local OTel/Prometheus/Grafana/Loki/Tempo profiles, synthetic rules/rehearsals and selected live local trace/log links are recorded in the [Stage 11 plan](../docs/STAGE_11_PLAN.md). | Deploy collectors and backends with the cell; observe real web, phone, event, database and alert journeys; approve SLOs and prove alert routing under representative load. |
| Stage 12 infrastructure | [Terraform static evidence](STAGE_12_TERRAFORM_STATIC.md) and [disposable root evidence](STAGE_12_DISPOSABLE_TERRAFORM.md) cover syntax/synthetic planning. The disposable root now validates private RDS/S3, CloudFront/WAF/ALB, Cognito and EBS CSI resources offline. | One authenticated plan must include the remaining data, secret wiring, controllers, apps and teardown ownership. It currently does not. |
| Stage 12 workloads | [Helm evidence](STAGE_12_HELM_BASELINE.md), [runtime deployment inventory](../infra/gitops/RUNTIME_DEPLOYMENT_INVENTORY.md) and [local gate](STAGE_12_LOCAL_GATE.md) cover render, selected fault tests and base Compose verify/smoke. | Install the exact immutable images and every required service, prove probes, migrations, network/mesh access, actual broker/storage connectivity and app flows in a disposable cluster. |
| Stage 12 release/security | Static GitOps, admission, image-inventory and CI definitions exist. | Publish/sign images, install Argo CD/Rollouts, Kyverno and runtime detection; prove bad manifests rejected and a failed canary rolled back. |
| Stage 12 availability/DR | Local HPA/KEDA render, scheduling policy, resource checker and isolated Postgres restore evidence exist. | Install controllers and data owners, measure node/backlog scaling, zone and failure recovery, all-store restore, cost alerts and complete teardown. |
| Stage 13 capacity/resilience | A [scale model](../docs/SCALE_AND_PRODUCTION_READINESS.md), [Stage 13 acceptance plan](../docs/STAGE_13_PLAN.md), [chaos test inventory](../tests/chaos/README.md) and local Stage 12 resilience checks exist. | Agree on a bounded disposable-cell workload, then run load, soak, queue-backlog, node-loss, broker/store-fault and recovery exercises against the deployed cell. The 10-million-user target is not certified. |
| Web and iPhone | Dashboard/mobile OAuth clients, mobile PKCE/Keychain/URL callback, local BFF tests, and opt-in Cognito access-token validation exist. Terraform emits public web/mobile configuration for AWS-owned HTTPS names. | Reachable ingress targets, real IdP users and tenant memberships, web callback and build settings, iPhone signing/install, login and alert read/ACK/live-update acceptance. |

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

| Command | Result | Limit |
| --- | --- | --- |
| `make COMPOSE='docker compose -p greenguard-stage12 --env-file .env -f infra/compose/compose.yaml -f infra/compose/stage12-isolated.override.yaml' verify` | Exit 0 after the control-plane, Sonar BUG and new-code style fixes: migrations, risk tests, workspace format/lint/typecheck/tests, Go checks and builds passed | Does not start Kafka, Cassandra, OpenSearch or AWS; rerun after any further source edit |
| `make COMPOSE='docker compose -p greenguard-stage12 --env-file .env -f infra/compose/compose.yaml -f infra/compose/stage12-isolated.override.yaml' coverage` | Exit 0 after the final source edits: repository coverage command produced Sonar reports | Some opt-in live suites remain skipped |
| `make COMPOSE='docker compose -p greenguard-stage12 --env-file .env -f infra/compose/compose.yaml -f infra/compose/stage12-isolated.override.yaml' smoke` | Exit 0 after the final source edits: live DB readiness, unavailable DB 503, application-role limits and cross-database denial | Health/security smoke only; no Kafka, cloud, web or phone journey |
| `npm run test -w @greenguard/dashboard` | Exit 0: 19 files, 78 tests passed after the Cognito scope/config change | Browser against AWS and physical iPhone remain unrun |
| `bash scripts/helm-validate.sh` | Exit 0: dashboard/BFF/runtime profiles and negative fixtures passed | Render/lint only; no cluster rollout |
| `ruby infra/gitops/disposable/check-contract.rb` | Exit 0: 15 releases, 14 images, six explicit blocking gaps | Structural check; `--ready` must fail until deployment prerequisites are implemented |
| `terraform -chdir=infra/terraform/disposable fmt -check` and `validate` (repo-local Terraform 1.16.4) | Exit 0 after the edge/data/identity/CSI merge | No authenticated AWS plan or provider-side resource creation |
| `ruby infra/gitops/disposable/check-contract.rb`, `check-controllers.rb`, `ruby infra/kubernetes/disposable-data/check-contract.rb`, `bash infra/gitops/disposable/check-target-bindings.sh` | Exit 0: inventories and route/data shapes validate | `check-contract.rb --ready` and `check-controllers.rb --ready` correctly fail on missing deployment requirements |
| `bash infra/terraform/disposable/teardown_test.sh` | Exit 0: 36 guarded teardown/inventory fixtures, including Argo ownership, retained EBS PV IDs across destroy retries with or without EKS, exact RDS/S3/edge inventory and state-output errors | Stubbed AWS/Kubernetes only; no real destroy |

Terraform 1.16.4 validation of the combined disposable root passed after the
edge/data/identity/CSI merge; this does not establish provider acceptance.
No authenticated AWS plan, apply or destroy was run.

## Local SonarQube quality measurement

The fresh isolated `greenguard-audit` Compose project scanned the working
tree after `make coverage`. The scanner container could not follow this
worktree's `.git` pointer to a Git directory outside its mount, so the local
scan used `sonar.scm.disabled=true`; it still analyzed source, imported
coverage, and applied the configured quality gate. Repository coverage was
**83.9%** (line 83.9%, branch 84.2%) on the final refreshed scan, above the 80%
condition, with zero security hotspots. The strict overall gate **failed** on
224 total violations (0 in the new-code period) and 0.6% duplicated lines, where
its thresholds are zero. These results describe
the shared dirty tree, not a clean CI commit. The scan does not prove a
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
