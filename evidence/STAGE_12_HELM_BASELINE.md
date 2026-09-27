# Stage 12.1–12.2 — Helm baselines

Date: 2026-09-26

## Scope

Created the first deployable workload chart at
`infra/helm/greenguard-dashboard`. It requires an immutable OCI digest, runs
with a non-root UID, drops all Linux capabilities, disables privilege
escalation and service-account token mounting, sets a read-only root filesystem,
provides bounded CPU/memory, HTTP probes, a PodDisruptionBudget, and a ClusterIP
service.
The dashboard NetworkPolicy allows ingress only from the configured Istio
ingress-gateway namespace and pod selector; egress is limited to cluster DNS
plus the configured gateway, device and telemetry pods on their service ports,
selected by namespace and release instance labels. Istio injection is opt-in. When enabled, the policy adds only
the configured Istiod control-plane port; optional OTLP collector egress and
Prometheus merged-metrics ingress have independent selectors and ports. OTel
remains a separate agent/gateway deployment, not another app sidecar. Optional
strict mTLS and selector-scoped ALLOW AuthorizationPolicy require explicit
trusted service principals. No credentials are stored in chart values.

The dashboard chart also exposes optional node selector, affinity, toleration,
topology-spread and priority-class fields. All default to inert/empty values;
target cluster labels, taints, zones and priority classes are operator inputs.

The first dedicated runtime-service chart is `infra/helm/greenguard-bff`. It uses the
service's actual port 4000, `/healthz` startup/liveness and `/readyz` readiness
checks, a namespace-and-pod-selector-scoped Istio ingress allowance, bounded
resources, PDB and the same hardened container defaults. Backend egress peers
are deliberately empty until environment-specific Service selectors and ports
are confirmed. OIDC/JWKS external egress also needs a cluster-approved design.
Sensitive BFF configuration must be injected through Secret references.

The reusable `infra/helm/greenguard-service` chart accepts an explicit list of
namespace-and-pod-selector ingress peers and defaults that list to empty. The
gateway profile allows Istio ingress and dashboard reverse-proxy traffic;
device-service and telemetry-ingest allow dashboard traffic; Read API allows
gateway and BFF traffic; workflow-alerts allows BFF traffic. Worker profiles use
an empty ingress peer list. Dashboard selectors use the chart's actual
`greenguard-dashboard` name label. The chart rejects HTTP probes when the HTTP
Service/port is disabled and requires PDBs to be disabled for KEDA minimum
replica counts below two.
These selectors assume the listed Helm release names and standard chart labels;
the disposable-cluster test must verify them against the deployed releases.

The reusable `infra/helm/greenguard-service` chart now has nine named HTTP
service profiles: gateway (4002), device-service (3001), read-api (4001),
workflow-alerts (3004), telemetry-ingest (8080), cdc-transformer (8081),
projection-builder (8082), cache-invalidator (8091) and risk-engine (8086).
Each profile carries the service's HTTP health paths and bounded hardened
workload defaults. The profile image remains unset; the release must provide
the verified published image digest. Environment-specific secret references
and NetworkPolicy peer selectors also remain operator inputs.

Two worker profiles use the same chart with Services and HTTP probes disabled:
`hardware-service-worker` and `eventbridge-bridge`. Both select the `compute`
node class, tolerate its `NoSchedule` taint, deny inbound pod traffic and use a
60-second termination grace period. The single-replica workers disable PDBs.
Their runtime egress to Kafka, PostgreSQL, MQTT, EventBridge and SQS must be
configured to match the target's real endpoint architecture before rollout.

## Validation

Command: `make helm-validate` (rerun after ingress peer and probe/port review fixes)

Result: passed for the dashboard, BFF, ten HTTP runtime profiles and three
worker profiles. The BFF and five synchronous HTTP profiles render HPA v2
resources with min 2, max 10 and a 70% CPU target; deployments leave replicas
unset when the HPA owns scale. The validation also renders a KEDA ScaledObject for the
hardware worker using its actual Kafka consumer group and command topic, and
rejects overlapping HPA/KEDA ownership.
`helm lint` reported one informational recommendation that the
chart icon is optional. Rendering without an image reference was rejected;
rendering with the all-zero validation digest succeeded and the script checked
for digest pinning, non-root/read-only settings, dropped capabilities,
non-escalation, health probes, rolling-update availability, unique release
resource names and NetworkPolicy. It checks mesh-disabled defaults and a
mesh-enabled render with explicit mTLS and allowed principals, as well as
Istiod, OTLP collector and Prometheus allow-list paths. It rejects missing
principals, invalid metrics merge/port combinations, and a PDB that would block
all voluntary disruption. Earlier scoped CodeRabbit reviews found and corrected
dashboard label quoting, ingress peer label, and KEDA/PDB minimum validation
issues; the final scoped CodeRabbit review on 2026-09-26 completed with zero
findings after those corrections.

Two scoped CodeRabbit reviews identified three applicable issues: backend
egress selectors needed namespace and workload-instance matching; resource
names needed to include the Helm release; Prometheus scrape settings needed to
match Istio's merged metrics endpoint. The chart and render checks now enforce
all three.

The same command lints all profiles and checks the rendered BFF's immutable
digest, port, readiness/liveness paths, Istio ingress namespace and pod
selector, read-only root filesystem, PDB and default-disabled mesh injection.
This verifies static chart shape only; it does not verify that the configured
ingress selector, BFF dependencies, secret references or network paths work in
a target cluster.

The placeholder digest is syntactic test input only; it does not identify an
image and must not be installed. This offline check does not exercise a cluster,
ingress controller, NetworkPolicy implementation, rollout, or recovery.

`make verify` was attempted after the Helm gate. Its planning check passed, then
the database startup prerequisite stopped because this checkout has no `.env`
file. No environment file was generated; application integration tests did not
run. There is also no configured Kubernetes context or local `kind` cluster in
this session, so disposable rollout acceptance remains pending.

Repository planning check passed during the `make verify` attempt (368
catalog/disposition entries, 141 unique coverage rows, component READMEs and
local Markdown links). The check completed before the missing `.env` stopped
database startup.

## Remaining Stage 12 gates

- Add profiles for any remaining runnable worker images and prove
  HTTP/worker traffic paths and policies in a disposable Kubernetes cluster.
- Add disposable cluster startup/rollout smoke and failure/rollback evidence.
- Complete blocking code, secret and container scanners, retaining reports and
  distinguishing scanner failures from zero findings.
- Sign images and verify signatures, SBOMs and provenance against the same
  immutable digest used by deployment.
- Complete Terraform/CDK ownership, state recovery, secret rotation and
  workload-identity denial proof.
- Exercise Argo Rollouts with metric analysis that detects and rolls back a bad
  canary; finish mesh/cloud-edge profiles and staging journey evidence.
- Stage 09–11 prerequisites remain separately tracked in the milestone plan.
