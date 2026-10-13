# Disposable runtime contract

## Controller bootstrap gate

`controllers.json` inventories seven ordered controller releases. Run
`ruby infra/gitops/disposable/check-controllers.rb` to validate its structure;
`ruby infra/gitops/disposable/check-controllers.rb --ready` remains intentionally
red. `infra/terraform/disposable/controllers.tf` now pins and owns all seven
Helm releases, including Argo CD and their destroy order. Terraform connects
with EKS exec credentials, so the operator needs cluster-admin EKS access and
network reachability to the API endpoint. The public chart repositories are
version-pinned but do not yet have an integrity check. Terraform can install
the root Argo CD Application through `gitops.tf` when given a 40-character
commit SHA and one OCI digest per published image. The root points at
`applications-chart` at that exact commit; it renders a wave-10 data
Application, a wave-20 RDS role/database bootstrap Application, a wave-25
owner-migration gate Application, and every release in `contract.json` as a
wave-30 child Application. The migration gate deliberately fails Helm render
until real owner migration Jobs have been packaged and verified. Argo CD's Application health
customization in `controllers.tf` forwards each child Application's health to
the parent; without it, the wave labels do not wait for data readiness.
The search-indexer PVC uses `WaitForFirstConsumer`, so the data Kustomization
ignores that claim's health until its wave-30 Pod binds it. Run
`ruby infra/gitops/disposable/check-application-tree.rb` to check the local
render. The bootstrap Job needs the pre-provisioned Secrets described in
`rds-bootstrap-chart/README.md`; Terraform does not yet sync them from
Secrets Manager. No owner schema migration Jobs or live sync proof exists,
so the full deployment gate
remains closed. The
order requires Pod Identity
and controller webhook reachability before
the TargetGroupBinding, then healthy Istio CRDs and ingress before mesh routing,
then KEDA/Rollouts CRDs before app charts, and an Argo application tree with
immutable image digests before deployment. The `--ready` gate may be opened only
after those artifacts and live preflight checks are implemented.

`contract.json` names the required installation phases and the 21 currently
templated application releases, including their chart, profile, published
image, Kubernetes Secret contract, and readiness probe. It also records the
unimplemented prerequisites that prevent a safe AWS application deployment.

```sh
ruby infra/gitops/disposable/check-contract.rb
ruby infra/gitops/disposable/check-contract.rb --ready
```

The first command validates the inventory structure against repository
artifacts. The second is deliberately fail-closed and prints the blocking
gaps. Neither command reaches AWS. In particular, the contract is **not** an
Argo CD Application or a Helm values file. Before Terraform can install it,
the controller/data/migration phases need implementations, immutable digests
and Secret references must be supplied, and the application release set must
cover all required services. The ready gate must then validate those actual
inputs and live prerequisites rather than simply removing gap text.

## Stage 11 observability gate

The optional Argo tree now contains a wave-15 disposable observability
Application. Its [chart](observability-chart/README.md) owns five private,
digest-pinned backends and bounded ephemeral storage; Terraform requires exact
image digest inputs and a `grafana-admin` secret container. Run
`ruby infra/gitops/disposable/check-observability.rb` for the static gate.
The runtime Helm charts still default collector egress and Prometheus scraping
to disabled, and Terraform does not inject `OTEL_EXPORTER_OTLP_ENDPOINT` into
runtime values. Service instrumentation and local dashboards therefore do not
establish cluster telemetry delivery. Stage 11 remains blocked on runtime
export wiring, matching NetworkPolicy peers, scrape discovery, rule/dashboard
provisioning, and live metrics, logs and trace acceptance.

## Runtime network peers

`ruby infra/gitops/disposable/check-network-peers.rb` renders every runtime
chart and verifies 15 service links plus 21 links to the disposable Kafka,
RabbitMQ and Redis pods by namespace, pod label and TCP port. It also checks
the data ingress policies and rejects a world-wide CIDR egress override. The
service chart rejects `0.0.0.0/0` and `::/0` at render time.

These rules cover only the data services currently represented by Kubernetes
pods. RDS/PgBouncer, Cognito JWKS, AWS APIs, SendGrid, Twilio, Stripe, MQTT,
Cassandra and OpenSearch still need deployment-specific outbound routes and
matching ingress or endpoint policy. Standard Kubernetes NetworkPolicy cannot
select an external FQDN, so those routes need a pinned egress gateway or a
reviewed CNI policy with DNS-aware egress. Do not use a broad CIDR as a stand-in
for those endpoints. Contacts CDC's Schema Registry client belongs to a
separate projector runtime that is not yet in the Argo release inventory.

The current disposable root cannot prove a safe external egress gateway. Its
`vpc-cni` add-on has no explicit NetworkPolicy enforcement configuration, Istio
has no egress gateway or outbound host registry, and private subnet NAT routes
lead to the internet without a destination owner. The RDS endpoint is known
only after apply and may change IP; Cognito JWKS, AWS APIs and provider hosts
also cannot be represented by stable pod or CIDR peers. Before adding runtime
egress, pin and own the CNI enforcement mode, an egress gateway with a scoped
service account and NetworkPolicy ingress, allowed hostname/port inventory and
TLS/SNI checks, VPC endpoint or RDS routing, and gateway-level denial for
unlisted destinations. Render those objects against the final AWS region and
account, then prove from live pods that listed destinations work and unlisted
destinations fail. Until then, external egress remains a deployment blocker.

## Private ALB to Istio ingress

Terraform owns one private ALB and one IP target group. The target group binds
only the `istio-system/istio-ingressgateway` Service (port 80, pod target port
8080), leaving dashboard and BFF behind Istio mTLS. The target group health
check uses ingress gateway port 15021 and `/healthz/ready`. Both CloudFront
HTTPS distributions send the `X-GreenGuard-Origin` origin header (`dashboard`
or `bff`); `mesh-edge-routing.yaml` routes those exact values to the two Helm
Services and returns 404 for any other value. Its DestinationRules require
`ISTIO_MUTUAL`. This routing must be verified in EKS with the actual gateway
labels, service account principal, and CloudFront header behavior.

The AWS Load Balancer Controller must be installed in `kube-system` with service
account `aws-load-balancer-controller`. Terraform owns its Pod Identity role
and association in `infra/terraform/disposable/alb-controller.tf`. The role can
register/deregister targets in only the Terraform target group; it cannot
create load balancers or mutate security groups. Terraform owns the controller
chart/CRDs and Istio ingress gateway releases. The chart
values in `aws-load-balancer-controller-values.yaml` create the service account
and disable shared backend security group management. The TargetGroupBinding
omits `spec.networking`; Terraform owns the ALB-to-ingress security group
rules. AWS documents controller chart `1.14.0` for controller `v2.14.1`:
https://docs.aws.amazon.com/eks/latest/userguide/lbc-helm.html

Once the controller, ingress gateway and app Services are installed, render the
binding from the **actual** Terraform output:

```sh
terraform -chdir=infra/terraform/disposable output -json edge_target_group_binding > target-group.json
ruby infra/gitops/disposable/render-target-group-bindings.rb target-group.json > target-group-binding.yaml
```

Do not apply the example ARN. The app Helm release names are `dashboard` and
`bff`, giving Services `dashboard-greenguard-dashboard` and
`bff-greenguard-bff`. Their mesh settings must enable sidecar injection,
strict mTLS, and AuthorizationPolicies allowing the actual ingress gateway
principal. Verify the controller webhook is reachable from the EKS control
plane on node TCP 9443 and the target group registers healthy ingress pod IPs.
AWS and Istio references:
https://kubernetes-sigs.github.io/aws-load-balancer-controller/v2.11/guide/targetgroupbinding/targetgroupbinding/
https://istio.io/latest/docs/reference/config/networking/virtual-service/
# Immutable image release inputs

After images have been published or copied into a registry that EKS can pull,
provide a JSON object mapping each of the image names in `contract.json` to
its full digest reference. For example:

```json
{"bff":"123456789012.dkr.ecr.us-east-1.amazonaws.com/greenguard/dev/cell-0123456789abcdef/bff@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}
```

The main-branch CI `greenguard-release-inputs-<commit>` artifact contains
signed exact-commit GHCR digest references only when every exact manifest can
be pulled anonymously. Package owners must publish all 20 GHCR packages as
public before this route can pass; publishing an image does not itself prove
that the package is public. The September 2026 audit of existing `latest`
manifests found mixed anonymous access, so this route is **not yet green**.
To avoid an ECR bootstrap cycle during the first disposable apply, use that
artifact directly only after checking the intended Git checkout:

```sh
python3 infra/gitops/disposable/check-public-release-images.py \
  release-inputs/release-inputs.tfvars.json "$(git rev-parse HEAD)"
```

This read-only preflight rejects missing, foreign, mutable, inaccessible or
changed manifests. It does not prove EKS NAT egress, architecture support,
image startup or workload health; those require live acceptance. The existing
ECR promotion script is optional for a later ECR-backed rollout. It cannot be
used as a prerequisite for a single first apply because Terraform creates the
target ECR repositories in that same apply.

The real manifest must contain every image. Run
`ruby infra/gitops/disposable/resolve-images.rb manifest.json release-images`.
It writes one immutable `image:` Helm values file for each release.
The resolver rejects missing, extra and mutable references before writing any
files. `test-resolve-images.rb` runs this contract in CI. This does not publish
images, authenticate EKS to a registry, supply service secrets or deploy the
charts; the deployment readiness gate remains blocked.

## Disposable Cognito runtime values

The Terraform root now passes public Cognito OIDC values into its pinned Argo
CD child Applications. The dashboard receives `publicOidc` so its chart serves
`/config.json` and permits the Cognito hosted login/token origin in CSP. BFF,
gateway, device, read, alerts, notification and tenant control-plane releases
receive the exact pool issuer, JWKS URL, `cognito-access` token mode, and both
public client IDs. The API verifier releases use
`AUTH_MEMBERSHIP_SOURCE=control-plane` with the internal control-plane URL.
The values explicitly clear a legacy `AUTH_AUDIENCE`; resource-bound Cognito
audiences require a separate reviewed change.

Every non-dashboard runtime Application references its contract-named
Kubernetes Secret through `envFrom`. Argo/Terraform pass only the Secret name,
never its value. Before enabling the application tree, the operator must
create and verify each Secret with the service's required database, broker,
`CONTROL_LOOKUP_TOKEN`, Redis/Kafka membership-consumer and other credentials.
The same lookup token must be supplied to the control plane and its calling
services. At present, `secret_names` creates **empty AWS Secrets Manager
containers** and there is no External Secrets controller or manifest that
materializes their values as Kubernetes Secrets. These Secret values, sync,
network
reachability and live membership lookup remain deployment blockers. A real
OIDC account still needs the first-admin enrollment workflow in
`docs/runbooks/disposable-oidc-first-admin.md` before tenant APIs can be used.

## Data-plane Argo children

The applications chart can render five additional child Applications when
`dataPlane.enabled` is `true`: Kafka ACL/topic bootstrap at wave 12, Schema
Registry at wave 13, PgBouncer at
wave 22, Kafka Connect at wave 23, and connector registration at wave 24. The root bootstrap chart passes the
same values through and rejects incomplete or mutable inputs before creating
the root Application. The required values are:

```yaml
dataPlane:
  enabled: true
  rdsHost: db.example.us-east-1.rds.amazonaws.com
  images:
    pgbouncer: registry.example/greenguard/pgbouncer@sha256:<64 hex digits>
    kafka-topics: registry.example/greenguard/kafka@sha256:<64 hex digits>
    kafka-connect: registry.example/greenguard/connect@sha256:<64 hex digits>
    connector-registration: registry.example/greenguard/python@sha256:<64 hex digits>
  secrets:
    pgbouncerAuth: greenguard-pgbouncer-auth
    rdsCa: greenguard-rds-ca
    cdcCredentials: greenguard-cdc-credentials
```

The sample digest placeholders above are documentation only and fail Helm's
input validation. `ruby infra/gitops/disposable/test-data-plane-applications.rb`
checks the positive tree and reject cases. The children are disabled by
default. Enabling them requires published image digests, populated Kubernetes
Secrets, a reachable RDS host, and live connector/schema registration proof.
The current Kafka manifest requires SASL/PLAIN over TLS; ACL bootstrap and live
broker/client verification remain open. No live data-plane
readiness is claimed by these Argo manifests; `check-data-plane.rb --ready`
remains fail-closed.
