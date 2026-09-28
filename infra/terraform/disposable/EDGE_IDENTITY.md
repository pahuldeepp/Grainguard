# Disposable AWS edge and identity contract

This cell has no custom DNS domain. Terraform owns two CloudFront distributions
with AWS-provided `*.cloudfront.net` HTTPS names, one for the dashboard and one
for the mobile BFF. Their origin is one internal ALB through a CloudFront VPC
origin. A WAF ACL protects both distributions. The ALB is not internet-facing;
CloudFront's origin-facing prefix list is its only ingress security-group
source. CloudFront injects `X-GreenGuard-Origin: bff` or `dashboard`. The ALB
targets the Istio ingress gateway, whose VirtualService routes by that header
to BFF or dashboard. These resources are in this
Terraform state and are subject to `terraform destroy`.

AWS documents VPC origins for internal ALBs, including us-east-1 and
us-west-2, with several excluded AZ IDs. `edge.tf` rejects unreviewed
regions and those excluded AZs. See [CloudFront VPC origins](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/private-content-vpc-origins.html).

The Terraform output `edge_target_group_binding` names the IP target group and
Istio ingress Service that must be bound by AWS Load Balancer Controller/
TargetGroupBinding:

| Target group | Namespace / Service | Service port | Pod target port | Health |
| --- | --- | ---: | ---: | --- |
| `mesh_ingress` | `istio-system/istio-ingressgateway` | 80 | 8080 | port 15021 `/healthz/ready` |

The AWS Load Balancer Controller must have its own scoped IAM permissions and
Pod Identity/IRSA configuration. Creating the target group does not register
targets; the edge is unavailable until TargetGroupBinding, Istio Gateway,
VirtualService header routes, and healthy pod endpoints are proven live. The
ingress gateway then uses mesh mTLS to reach strict dashboard and BFF pods.

The default identity mode preserves the supplied OIDC provider; Cognito is an
explicit disposable-cell opt-in only. The provider must support public web and
native Authorization Code + PKCE clients and issue JWT access tokens for the
configured API audience. Register the web callback from Terraform output and
the app's `greenguard://auth/callback` with the provider. No provider secret or
user credential is stored in Terraform. A valid login still needs an
authoritative GreenGuard tenant membership. The account-guarded
`enroll-first-admin.sh` verifies a signed access token against the selected
issuer/JWKS/audience (or the explicit Cognito client allowlist), then creates
only the first admin membership for a new tenant. It requires explicit
operator confirmation, the exact disposable Terraform cell and matching
current AWS account, plus a private operator database connection. The token
enters through an owner-only file and standard input; it is not logged or
stored in state. See the
[provider-neutral enrollment runbook](../../../docs/runbooks/disposable-oidc-first-admin.md).

The following Terraform outputs are public deployment configuration:

- `oidc_public_configuration`: issuer, JWKS, hosted endpoints and public
  client IDs for BFF verification and runtime deployment.
- `dashboard_helm_public_oidc_values`: values for the dashboard chart's
  `/config.json` and CSP connect origins.
- `mobile_deployment_config`: JSON accepted by the iOS shell's build-time
  configuration generator. From this directory, write the public file and
  configure the app with:

  ```sh
  terraform output -json mobile_deployment_config > ../../../apps/mobile/shell/deployment.local.json
  (cd ../../../apps/mobile/shell && npm run configure:aws -- deployment.local.json)
  ```

  The file contains only HTTPS endpoints, public client IDs/audience selection,
  and scopes; it contains no password, token or client secret. For Dex, set
  `mobile_audience_mode = "scope"` and use audience `greenguard-dashboard`;
  for a provider that supports the standard parameter, set
  `mobile_audience_mode = "query-param"`. The physical iPhone build and
  its login/API journey still require a live device acceptance run.

For the default existing OIDC provider, set `AUTH_TOKEN_MODE=audience`,
`AUTH_ISSUER`, `AUTH_JWKS_URL`, and `AUTH_AUDIENCE` from the public output.
Configure the tenant membership store separately and fail closed when it has
no mapping for a verified `(issuer, subject)` pair. Dashboard Helm must
consume the runtime public OIDC values after the CloudFront hostnames exist.
The explicit Cognito mode uses `cognito-access` and the public client allowlist.

The post-destroy inventory checks exact ALB, CloudFront distribution, VPC
origin, WAF ACL, Cognito pool, and hosted-domain names in addition to regional
tagged resources. It fails if one remains or if an AWS inventory call fails.
CloudFront/WAF are global resources, so regional tag inventory alone is not
sufficient. No live AWS deployment or teardown has yet proven this path.
