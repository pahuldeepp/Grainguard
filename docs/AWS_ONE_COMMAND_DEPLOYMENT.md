# AWS one-command deployment audit

Status: **not end-to-end ready** (2026-09-27). `terraform apply` in
`infra/terraform/disposable` currently describes a partial AWS foundation,
private RDS/S3 data storage, HTTPS edge, Cognito issuer and pinned controller
bootstrap, not a working
GreenGuard environment. No authenticated AWS apply/destroy or phone
test has been run. Do not treat a successful Terraform exit as proof that the
dashboard, mobile app, login or data flows are operational.

An explicit readiness gate now makes an ordinary plan/apply fail while this
root is incomplete. The override is for deliberately inspecting its resources;
it does not make an end-to-end deployment ready.

The target is one Terraform state for AWS-owned resources, with `terraform
plan`, `terraform apply` and `terraform destroy` from the same root. Apply
must bring up the backend and web app, publish usable HTTPS endpoints and
provide a mobile configuration output. Destroy must remove the resources it
created, run dependent Kubernetes/CDK cleanup first, and leave a clean AWS
inventory. Installing a signed iOS binary on a phone remains an Xcode/Apple
signing action; Terraform cannot install an app onto a personal device.

| Layer | Present in repository | Required before an end-to-end apply can be claimed |
| --- | --- | --- |
| AWS foundation | Disposable root creates VPC, NAT, private EKS, node groups, ECR, KMS, logs and optional empty Secrets Manager containers; VPC CNI policy support is configured from an exact add-on version | Authenticated plan/apply/destroy, account/region and supported add-on version selection, spending limits, reachable cluster API and live network-policy enforcement proof |
| Images | All 20 required image names have Dockerfile/CI/ECR inventory entries; six newly packaged runtimes built locally | Publish signed immutable digests to this account and supply exact digests to releases |
| Data | Private RDS/S3 Terraform, offline-checked Redis, RabbitMQ, Kafka and Schema Registry manifests, eleven digest-only PostgreSQL owner migration Jobs, and conditional PgBouncer/topic/Connect Argo children | Secure brokers and register connectors/schemas; add Cassandra, OpenSearch, MQTT, populated credentials, backups and service connectivity; apply migrations with real RDS credentials and prove RLS; current Kafka manifest lacks broker authorization |
| Services | Offline-validated charts and a pinned-commit/digest Argo CD Application tree cover 21 releases | Supply actual env/Secret references, data and migration Applications, working probes, policies, and live internal service DNS; current tree is disabled by default |
| Identity | Existing OAuth clients and local Dex fixture remain; disposable Terraform now defines Cognito public clients and hosted login; BFF has opt-in Cognito access-token validation | Invite real users, connect trusted issuer/JWKS/client IDs, seed tenant membership and prove login/revocation |
| Public edge | Terraform models CloudFront HTTPS/WAF/private ALB, seven locally archived controller Helm releases with SHA-256 locks, and an Istio ingress target group; static routing contract exists | Prove controller and ingress installation, registered targets, HTTPS, mTLS, auth policy, WAF and routing live |
| Web | Dashboard serves a SPA with a runtime public OIDC config contract | Build/deploy image and prove browser callback, GraphQL and live workflows through the public edge |
| iPhone | PKCE, Keychain, callback URL scheme, cold-start callback recovery, BFF client and configurable public HTTPS build profile | Configure the deployed auth/token and BFF URLs, Apple-sign and install the binary, then prove real-user login and alert flows on a phone |
| Operations | Local observability/resilience/static gates and digest-pinned Argo observability child with offline OTLP/HTTP and scrape wiring | Live cluster metrics/logs/traces, dashboards and alerts, rollout/rollback, scaling, backup/restore, failure and cost acceptance |
| Teardown | Disposable root has guarded pre-destroy cleanup and an account-scoped inventory; `destroy-verified.sh` runs destroy then inventory | Prove real destroy, remove remaining controller-created disks/DNS/logs, and inspect final AWS inventory; raw `terraform destroy` has no reliable post-destroy inventory exit status |

The local Dex file under `infra/oidc` uses loopback HTTP, memory storage and
development passwords. It is an OAuth test provider, not a deployed
production identity service. The app's OAuth code does not create user
accounts or GreenGuard tenant memberships. An AWS-owned Cognito pool is one
possible production provider without a custom domain, but its token claims
and OAuth endpoints differ from local Dex; the BFF and clients need an
explicit compatibility design and tests before choosing it. See the
[iPhone login runbook](runbooks/mobile-iphone-aws-login.md).

## No-domain login decision

The user has no custom DNS domain yet and wants real users. AWS can assign a
Cognito hosted-login domain and a CloudFront `cloudfront.net` HTTPS hostname.
Those are now modeled in Terraform, with public web/mobile configuration
outputs and disabled CloudFront caching. The Istio ingress target binding and
application delivery remain uninstalled, so the endpoints are not yet usable.
The assigned
hostname can change after destroy/reapply, so Terraform must register the
current web callback and emit a matching public mobile configuration each time.

Cognito is an opt-in production issuer for the disposable cell; local Dex
remains the development issuer. The verifier checks Cognito access-token
`client_id` and `token_use` while retaining the existing Dex mode. A real
user still needs an authoritative GreenGuard issuer/subject membership and
role before any tenant API call can succeed. No such production enrollment
has been run, so the existing OAuth client code is not proof of deployed login.

## Required acceptance before changing this status

1. Authenticated Terraform plan in the chosen account/region includes all
   required AWS resources and no out-of-state duplicate owner.
2. One apply builds/publishes or references verified image digests, installs
   data and application releases, runs migrations and reaches ready status.
3. A real user can sign into the web app and a signed iPhone build through the
   deployed HTTPS IdP, with tenant membership and roles enforced by the BFF.
4. Device ingest, read model, alerts, acknowledgement and reconnect work
   through the deployed stack; Stage 11 traces/metrics expose their failures.
5. A destroy from the same state tears down application owners before EKS/VPC;
   the post-destroy inventory finds no remaining chargeable GreenGuard
   resources. Billing and KMS deletion state are reviewed separately.

Stage 11 still needs production-representative observability and approved
SLOs. Stage 12 still needs cloud/cluster acceptance and missing deployment
components. Stage 13 capacity/soak/failure targets remain unmeasured. These
are independent of the basic Terraform foundation.
