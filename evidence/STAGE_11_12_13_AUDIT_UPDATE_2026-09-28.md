# Stage 11–13 pre-AWS audit update

Date: 2026-09-28. Scope: offline repository checks and isolated local
acceptance only. This update does not authorize or record an AWS plan/apply.

## Current offline evidence

- Argo contract renders 29 digest-pinned runtime Applications, data and
  observability components, RDS bootstrap, 38 owner-migration Jobs, and the SQL
  migration gate.
- The static network contract contains 15 service links and 34 data links.
- Four-shard tenant placement and migration support have local Risk-owner move
  evidence: copy verification, lease drain, writer fencing, epoch advance, and
  preservation of an unrelated tenant. This does not cover every data owner,
  replica lag, or a complete Redis/CDC migration journey.
- OIDC is provider-neutral by default. The web and mobile clients retain the
  existing OAuth/OIDC architecture. The mobile authorization-code exchange now
  requires an ID token with the expected nonce. First-admin enrollment obtains
  its control database URL from the exact Terraform-managed disposable secret;
  it does not place the URL in process arguments or print it.
- Workload bootstrap secrets and shard registry inputs are checked fail-closed.
  Notification-contact CDC uses a dedicated generated Secret and DynamoDB
  `PutItem` role scoped to its exact table. The entitlement heartbeat has a
  bounded runtime profile. Audit export and scheduled projection-history
  maintenance remain explicit first-cell blockers; broad migration credentials
  are not reused as worker credentials.
- Teardown tests cover exact resource inventory, partial-destroy recovery,
  DynamoDB/RDS/KMS and shard-secret checks, permission failures, and production
  guards. `destroy-verified.sh` performs pre-cleanup, Terraform destroy, and a
  final scoped inventory check; bare Terraform destroy does not perform that
  final verification.

## Commands and results

On the audited working tree:

- `bash infra/terraform/disposable/teardown_test.sh` — 55 passed.
- `ruby infra/gitops/disposable/test-projector-applications.rb` — passed.
- `ruby infra/gitops/disposable/check-application-tree.rb` — 29 runtime apps
  rendered.
- `ruby infra/gitops/disposable/check-network-peers.rb` — 15 service and 34
  data edges passed.
- `ruby infra/gitops/disposable/check-owner-migrations.rb` — 38 owner jobs
  rendered and validated.
- `ruby infra/gitops/disposable/test-data-plane-applications.rb` — passed.
- `python3 -m unittest discover -s infra/gitops/disposable -p
  'test_*secret*.py'` — 64 passed.
- `python3 -m unittest infra.gitops.disposable.test_check_deployed_workloads`
  — 19 passed.
- `ruby infra/terraform/disposable/identity-contract-test.rb` — 6 runs, 97
  assertions passed.
- `bash infra/terraform/disposable/enroll_first_admin_test.sh` — 7 passed.
- `ruby infra/terraform/disposable/lifecycle-audit-test.rb` — 6 runs, 45
  assertions passed.
- `git diff --check` and Python bytecode compilation for the workload and
  secret lifecycle checkers — passed.
- Earlier isolated checks also passed: mobile tests (72), Go common tests,
  notification service tests (111 passed, 26 skipped), entitlements (7), and
  Read API tests (111 passed, 8 opt-in skips). The tenant-control-plane full
  suite was not green without its configured database; its DB-backed targeted
  enrollment and isolated tenant-move checks passed separately.

Terraform formatting and validation passed earlier using Terraform 1.16 and
cached providers. No authenticated Terraform plan was run. No AWS API calls,
AWS apply/destroy, physical-iPhone test, or public IdP login was performed.

## Required before the end-to-end milestone

- Do not bypass the default Terraform readiness gate. Audit export and
  projection-history maintenance are still unimplemented for the first cell.
- Select and configure a compatible real OIDC provider, issuer, endpoints,
  client IDs, API audience, scopes, registered CloudFront callback, and
  `greenguard://auth/callback`; enroll a real tenant admin.
- Provide a private routed operator/runner for Helm against the private EKS
  endpoint and the control-plane secret/database path. A laptop without that
  route cannot complete first-apply Helm operations.
- Prove image publication/pulls, migrations, all runtime health, live database
  and broker integration, HPA/KEDA/Karpenter, external HTTPS, authenticated web
  flows, and physical-iPhone OAuth/API/alert workflows in the disposable AWS
  account.
- Run the guarded apply only after the pre-AWS gate is resolved. Then use the
  verified destroy wrapper and inspect its final AWS inventory. Multi-owner
  migration, replica-freshness and full Stage 13 capacity/resilience acceptance
  remain unproven until their live exercises complete.
