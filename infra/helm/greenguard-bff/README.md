# GreenGuard BFF Helm chart

This is the first runtime-service chart in Stage 12.2. It targets the BFF
container on port 4000, uses `/healthz` for startup/liveness and `/readyz` for
readiness, and carries the hardened dashboard baseline: digest-only images,
non-root/read-only execution, dropped capabilities, bounded resources, a PDB,
default-deny network policy, opt-in mesh policies, optional telemetry policy,
and optional pod scheduling controls.

The BFF requires runtime configuration such as OIDC issuer/audience/JWKS and
service URLs. Supply sensitive values through `envFrom`/`env` Secret references
in an environment-specific values file; never put secret values in chart
defaults. Its policy allows named Read API, workflow-alerts and Saga API peers
on their service ports. Verify the Saga release and all selectors in the target
cluster. External OIDC/JWKS connectivity needs an approved egress design (for
example an egress gateway) before a cluster rollout.

Ingress defaults to the Istio ingress gateway namespace and the conventional
`app=istio-ingressgateway` pod selector. Verify those labels against the chosen
Istio installation before deploying. The `mesh.authorization.allowedPrincipals`
list must contain the actual caller service accounts before enabling the
AuthorizationPolicy.

The chart enables an `autoscaling/v2` HPA with a two-replica floor,
ten-replica cap and 70% CPU utilization target; the Deployment leaves replica
count to the HPA. The target cluster must provide the resource metrics API.
This remains a static baseline and does not prove a working deployment.
Stage 12.2 remains in progress until the runtime service/worker charts and
disposable-cluster smoke tests are complete.
