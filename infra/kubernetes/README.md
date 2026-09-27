# infra/kubernetes

Status: **in progress** — the first hardened workload is in
`infra/helm/greenguard-dashboard`; no cluster rollout is yet verified.

Stages: 12.

Technology: Kubernetes.

Responsibility: Base policies, workload/service identities, resources and
probes. Kubernetes is an environment/cell boundary; tenant authorization stays
in the services and their tenant-scoped storage. Istio service identity and
AuthorizationPolicy will govern workload-to-workload traffic; they do not
replace JWT validation, role checks or RLS. The first chart disables
service-account token mounting, runs as non-root, drops Linux capabilities,
uses a read-only root filesystem, declares requests/limits and probes, and
restricts dashboard traffic with NetworkPolicy. Runtime NetworkPolicy behavior
and rollout recovery still require a disposable cluster. The chart has an
opt-in Istio sidecar mode with an explicit Istiod egress rule; OTel Collector
and Prometheus merged-metrics access are separate opt-in paths. Application
instrumentation sends OTLP to a Collector deployed as an agent or gateway, not
to another injected sidecar in each app pod.
Selector-scoped strict mTLS and AuthorizationPolicy templates are available as
explicit chart options; ALLOW policy requires an operator-supplied service
principal list. These govern workload identity only, not user or tenant auth.
The Stage 12 Kyverno namespace policy requires immutable digests, restricted
container security, and CPU/memory resources; its policy fixtures live in
`infra/kyverno` and still need Kyverno CLI and disposable-cluster enforcement
evidence.

Implement the linked requirements in the main coverage matrix and backlog. Completion requires runtime wiring, meaningful tests, relevant failure/tenant isolation evidence, and reproducible local/CI commands. Existing source reference archives live outside this fresh project.
