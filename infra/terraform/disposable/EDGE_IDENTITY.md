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

For an AWS cell with no existing production identity provider, Terraform owns
a disposable Cognito user pool and hosted prefix domain. This keeps the
existing OIDC Authorization Code + PKCE protocol. It registers separate public
web and native clients. The web callback is derived from the created CloudFront
hostname in the same Terraform graph; the native callback is the app's
`greenguard://auth/callback`. Both clients have no secret and permit only the
authorization code grant. Cognito user credentials and GreenGuard tenant
memberships are **not** stored in Terraform state. An invited, verified user
must be mapped to a tenant through GreenGuard's trusted membership store
before tenant APIs will authorize them. A user pool alone does not create a
usable tenant account. See [Cognito callback URI rules](https://docs.aws.amazon.com/cognito/latest/developerguide/user-pool-settings-client-apps.html).

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

  The file contains only HTTPS endpoints, a public client ID, and scopes; it
  contains no password, token or client secret. The physical iPhone build and
  its login/API journey still require a live device acceptance run.

For BFF verification with this pool, set `AUTH_TOKEN_MODE=cognito-access`,
`AUTH_ISSUER`, `AUTH_JWKS_URL`, and `AUTH_COGNITO_CLIENT_IDS` from the public
output. Configure the tenant membership store separately and fail closed when
it has no mapping for a verified `(issuer, subject)` pair. Dashboard Helm must
consume the runtime public OIDC values after both CloudFront and Cognito exist.

The post-destroy inventory checks exact ALB, CloudFront distribution, VPC
origin, WAF ACL, Cognito pool, and hosted-domain names in addition to regional
tagged resources. It fails if one remains or if an AWS inventory call fails.
CloudFront/WAF are global resources, so regional tag inventory alone is not
sufficient. No live AWS deployment or teardown has yet proven this path.
