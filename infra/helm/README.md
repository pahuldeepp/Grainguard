# infra/helm

Status: **in progress** — `greenguard-dashboard` is the hardened baseline,
`greenguard-bff` is the first dedicated runtime chart, and
`greenguard-service` provides profiles for ten additional HTTP workloads and
three workers.

Stages: 12.

Technology: Helm.

Responsibility: Portable app charts with digest-only images and verified
per-environment values. The dashboard chart uses a non-root/read-only pod,
health probes, bounded resources, a PodDisruptionBudget, a ClusterIP service and an allow-list network
policy. It contains no secret values. Install only with an image digest from a
verified release; a blank/default or mutable image reference fails schema and
template validation. Egress backend pods are matched by both namespace and
release instance label, with the chart namespace used when no backend namespace
is supplied. Istio sidecar injection is an explicit opt-in; enabling it adds
restricted egress to the configured Istiod selector on port 15012. Optional
OTLP export to a separate Collector and Prometheus scraping of merged Envoy /
application metrics add their own namespace-, label- and port-scoped rules.
The scrape target matches Istio's merged-metrics endpoint. Application-level
OpenTelemetry export should target that Collector; this chart does not add an
OpenTelemetry sidecar to the pod.
The chart requires metrics merge and scrape-port settings to match (`true` with
15020, or `false` with 15090).
Pod placement supports optional `nodeSelector`, `affinity`, `tolerations`,
`topologySpreadConstraints` and `priorityClassName`. Defaults leave scheduling
to Kubernetes. Configure these only against labels, taints, zones and priority
classes that exist in the target cluster; use resource/workload classes (for
example, general APIs versus event-processing workers), not transient traffic
levels, to select node pools. HPA/KEDA change pod counts; a node autoscaler such
as Karpenter supplies capacity when pods cannot be scheduled.
Strict mTLS and a selector-scoped ALLOW AuthorizationPolicy are independently
opt-in. AuthorizationPolicy requires strict mTLS and one or more explicit
Istio service principals; never enable it with an empty or guessed principal
list. These mesh policies control workload traffic and do not replace the
application's JWT/role/RLS checks.

Validate without a cluster (requires Helm 3):

```sh
make helm-validate
```

The validation digest is a syntactically valid placeholder used only for
rendering; it is not a published image and must never be installed. A
disposable-cluster rollout and network-policy test remain required for
acceptance. See [Stage 12 evidence](../../evidence/STAGE_12_HELM_BASELINE.md).
The BFF chart uses port 4000 and `/healthz`/`/readyz`; its runtime secrets and
actual backend egress peers must be supplied by the environment. See its
[chart notes](greenguard-bff/README.md). The reusable service chart has tested
profiles for gateway, device-service, read-api, workflow-alerts,
telemetry-ingest, cdc-transformer, projection-builder, cache-invalidator,
risk-engine, saga-api, hardware-service-worker, eventbridge-bridge and
saga-worker under `greenguard-service/values/`. The BFF and five synchronous
HTTP profiles render an `autoscaling/v2` HPA; the service chart also renders
KEDA ScaledObjects for Kafka workers when supplied with real triggers. Supply a published immutable
image digest at install time and inject secret-backed configuration from the
target environment. NetworkPolicy egress and ingress peers remain explicit
operator inputs, so a successful render does not prove application traffic can
flow.
Worker profiles disable Services and HTTP probes, require the `compute` node
class and taint toleration, deny inbound traffic, and use a 60-second
termination grace period (the hardware worker uses its checkpoint grace
period). Their external endpoint allowlists and Secret
references remain environment inputs. A rendered profile is not deployable
until those inputs match the target cluster.

Implement the linked requirements in the main coverage matrix and backlog. Completion requires runtime wiring, meaningful tests, relevant failure/tenant isolation evidence, and reproducible local/CI commands. Existing source reference archives live outside this fresh project.
