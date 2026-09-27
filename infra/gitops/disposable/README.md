# Disposable runtime contract

## Controller bootstrap gate

`controllers.json` inventories seven ordered controller releases. Run
`ruby infra/gitops/disposable/check-controllers.rb` to validate its structure;
`ruby infra/gitops/disposable/check-controllers.rb --ready` remains intentionally
red. Only the AWS Load Balancer Controller chart is currently pinned. Istio
base/control plane/ingress, KEDA, Argo Rollouts, and Argo CD still need exact
chart versions and checksum-verified sources. Terraform does not yet own their
install or removal, and no Argo CD Application tree installs the app releases.
Installing the controller set by hand would break the one-command lifecycle.
The order also requires Pod Identity and controller webhook reachability before
the TargetGroupBinding, then healthy Istio CRDs and ingress before mesh routing,
then KEDA/Rollouts CRDs before app charts, and an Argo application tree with
immutable image digests before deployment. The `--ready` gate may be opened only
after those artifacts and live preflight checks are implemented.

`contract.json` names the required installation phases and the 15 currently
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
create load balancers or mutate security groups. The controller chart/CRDs
and Istio ingress gateway are **not installed by this contract**. The chart
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
provide a JSON object mapping each of the 14 image names in `contract.json` to
its full digest reference. For example:

```json
{"bff":"123456789012.dkr.ecr.us-east-1.amazonaws.com/greenguard/bff@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}
```

The real manifest must contain every image, including the other 13. Run
`ruby infra/gitops/disposable/resolve-images.rb manifest.json release-images`.
It writes one immutable `image:` Helm values file for each of the 15 releases.
The resolver rejects missing, extra and mutable references before writing any
files. `test-resolve-images.rb` runs this contract in CI. This does not publish
images, authenticate EKS to a registry, supply service secrets or deploy the
charts; the deployment readiness gate remains blocked.
