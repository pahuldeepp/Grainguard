# Stage 12 — secure delivery and deployment

Stage 12 delivers a repeatable path from reviewed source to a running GreenGuard
environment. It includes immutable container artifacts, supply-chain evidence,
security gates, owned cloud infrastructure, hardened Kubernetes workloads,
secret injection, and observable GitOps canaries. A local chart render or a
successful CDK synthesis is not evidence of a cloud deployment or production
readiness.

## Current scope and ordering

| Slice | Scope | Acceptance evidence | Status |
| --- | --- | --- | --- |
| 12.1 | Baseline a hardened, mesh-ready dashboard Helm workload and portable defaults | `helm lint`, rendered-manifest checks for mesh off/on, explicit Istiod/collector/Prometheus policies, digest-only release input, and optional scheduling fields | Complete (offline validation; cluster rollout pending). Scheduling changes and ingress selector hardening revalidated 2026-09-26. |
| 12.2 | Helm charts for runtime services; probes, resource limits, identity and network policy | Render/lint every service profile and run a disposable Kubernetes rollout/smoke test | In progress — BFF, ten HTTP runtime profiles and three worker profiles pass offline lint/render; disposable-cluster rollout/network proof remains |
| 12.3 | CI security gates and image supply chain: dependency, secret, code and container scans; SBOM/provenance and signature verification | Deliberately vulnerable fixtures fail; immutable published digest has retained SBOM/provenance and verified signature | In progress — pinned secret/dependency/IaC scanners and an expected-fail IaC fixture are wired; all 13 runtime and dashboard Dockerfiles map to CI publication and Terraform ECR repos and pass static Dockerfile checks; remote scanner/build/signature evidence is pending |
| 12.4 | Terraform platform/network and separate CDK serverless ownership | Format/validate/plan without apply; ownership and state/lock/recovery runbooks | In progress — private EKS/VPC/state bootstrap/ECR roots pass static validation and synthetic no-credential plan; managed data services and authenticated AWS plan remain |
| 12.5 | Secrets Manager/External Secrets and workload identity | Rotation and least-privilege access/denial proof; no plaintext secret in Git, images, chart values or logs | In progress — EKS Pod Identity agent and an optional EventBridge bridge role are wired with exact service-account association and bus/queue-scoped permissions; synthetic plan confirms least privilege; Secrets Manager sync, rotation and live denial/identity proof remain |
| 12.6 | Argo CD promotion and Argo Rollouts canary analysis | Digest-only promotion; a real failed metric analysis rolls back a disposable release | In progress — dashboard chart has opt-in digest-only weighted Rollout and required Prometheus success-rate AnalysisTemplate with offline render gates ([static evidence](../evidence/STAGE_12_GITOPS_STATIC.md)); Argo CD promotion wiring and disposable failed-analysis rollback remain |
| 12.7 | Istio/Envoy service mesh and cloud edge profiles (mTLS, workload identity, AuthorizationPolicy, ingress, DNS, TLS, WAF) | Disposable-cluster mTLS and authorization proof, traffic policy tests, plus staging core-flow proof | Planned |
| 12.8 | Workload and node autoscaling: HPA for synchronous APIs, KEDA for Kafka/RabbitMQ consumers, Karpenter for node capacity | Load/backlog tests prove pod scaling, safe min/max behavior, scale-to-zero policy where applicable, and pending pods gain capacity without disrupting critical services | In progress — local sub-slice passed: BFF and six HTTP profiles render HPA v2; structured runtime checks verify exclusive replica ownership, CPU targets, scaling/PDB boundaries and expected drift rejection; hardware Kafka KEDA renders ([local gate](../evidence/STAGE_12_LOCAL_GATE.md)); metrics/KEDA controllers, real broker auth, load/backlog, live scale-to-zero and Karpenter capacity tests remain |
| 12.9 | Availability and placement: PDB, topology spread, anti-affinity, graceful termination, workload-class node pools and priority | Multi-AZ/node failure and drain tests prove replicas remain available and workers stop/checkpoint safely; placement uses resource profiles, not traffic labels | In progress — local sub-slice passed: per-profile PDB/grace/placement and scheduling drift checks; nine focused hardware worker race tests cover cancellation, join, subscription and connection recovery ([static evidence](../evidence/STAGE_12_SCHEDULING_STATIC.md), [local gate](../evidence/STAGE_12_LOCAL_GATE.md)); persistent QoS 1 behavior is implemented, while real broker redelivery, shutdown/checkpoint recovery, multi-AZ scheduling, drain and node-failure proof remain |
| 12.10 | Admission policy (Kyverno or Gatekeeper; select one) | Deliberately invalid manifests are rejected for digest pinning, privilege, security context and resource policy violations | In progress — selected Kyverno `NamespacedValidatingPolicy`; covers image digests, pod/container identity and seccomp, no capability additions, resources and ephemeral-container updates; isolated CLI fixtures and disposable subresource rejection script are present, but CLI evaluation and API-server proof remain |
| 12.11 | Runtime security detection (select Tetragon or Falco) | Controlled suspicious-process/network fixture produces an actionable event and alert | In progress — Falco selected; scoped shell-execution and AWS metadata connection rules plus CLI validation entry point added ([static evidence](../evidence/STAGE_12_RUNTIME_DETECTION_STATIC.md)); rule-engine validation, runtime events and alert delivery remain |
| 12.12 | Resilience and traffic policy: timeouts, bounded retries, circuit breaking, rate limits and idempotency boundaries | Fault injection proves bounded failure behavior and no duplicate side effects for retried operations | In progress — local sub-slice passed: deterministic BFF timeout/retry/breaker checks, one-attempt stalled gateway POST, and telemetry retry/commit-frontier race tests ([resilience evidence](../evidence/STAGE_12_RESILIENCE_LOCAL.md), [local gate](../evidence/STAGE_12_LOCAL_GATE.md)); disposable mesh timeout/retry/outlier-ejection, edge/WAF limits and durable duplicate-effect proof under database/broker partitions remain |
| 12.13 | Backup, restore and disaster recovery | Restore exercise meets documented recovery objectives for owned stateful systems | In progress — local sub-slice passed: isolated PostgreSQL dump/restore and restored RLS verification; final repeat run confirms cleanup by successfully created container IDs, their anonymous test volumes and dump directory; six fixture regressions prove failure/name-collision ownership ([recovery evidence](../evidence/STAGE_12_BACKUP_RESTORE_LOCAL.md), [local gate](../evidence/STAGE_12_LOCAL_GATE.md)); service databases, Kafka/Cassandra, approved/measured RPO/RTO, managed backup, encryption/key recovery and regional recovery remain |
| 12.14 | Cost and resource governance | Capacity/scale-down and budget thresholds are measured and alert before spend limits are exceeded | In progress — local sub-slice passed: chart resource/replica caps, narrow Terraform node-input wiring checks and expected-fail resource/HCL/budget fixtures ([governance runbook](runbooks/cost-resource-governance.md), [local gate](../evidence/STAGE_12_LOCAL_GATE.md)); proposed limits need operator approval, final deployment overrides, named budget owners/contacts and amount/currency, authenticated Terraform plan, deployed capacity/scale-down measurements and delivered billing alerts remain |
| 12.15 | End-to-end staging acceptance and operations evidence | Staging reproduces core flows; recovery and rollback evidence; review all Stage 12 coverage rows | Planned |

## Local gate — 2026-09-27

The [consolidated local gate](../evidence/STAGE_12_LOCAL_GATE.md) records command
output, the isolated restore cleanup proof, full Compose-backed `make verify`
and `make smoke` results, and infrastructure/tooling blockers. Helm
lint/render, local resource governance, all local workspace tests/builds, Go
vet/race suites, recovery fixture tests, script syntax and image inventory
checks passed. The base Compose gate uses isolated Postgres/PgBouncer storage;
the smoke starts Telemetry Ingest and Device Service locally and proves DB
readiness, failure behavior, role limits and database separation. Kyverno and
Falco entry points exited 127 because their CLIs are absent. These results
qualify local/static sub-slices only; cluster acceptance for the mesh,
autoscaling, admission, runtime detection, canary rollout and staging remains
pending. Stage 12 remains in progress; this is broader than AWS API setup alone.

## Constraints

- Do not apply Terraform, deploy to a shared cluster, or create paid cloud
  resources as part of local validation. Cloud credentials and target
  environment ownership must be supplied by the operator.
- Images promoted to non-local environments must be referenced by registry
  digest. Mutable tags are for local development only.
- Chart values contain no credentials. Use external secret references and
  workload identity once the owning cloud profile is configured.
- Kubernetes namespaces are environment/cell boundaries, not tenant
  boundaries. Tenant isolation remains in service authorization and storage.
- Istio workload identity and AuthorizationPolicy govern service-to-service
  traffic only. JWT validation, role checks and database RLS continue to enforce
  user and tenant access inside each service.
- Initial public edge profile is AWS WAF → ALB → Istio ingress → BFF. AWS API
  Gateway remains an optional profile when external API management needs
  (such as developer API keys, usage plans/quotas or AWS integrations) justify
  its extra hop and ownership. Istio ingress is the mesh entry; it is not a
  substitute for application authorization.
- Node pools are classified by workload/resource shape (general API versus
  event/compute workers), never by momentary “high” or “low” traffic. HPA scales
  synchronous pods, KEDA scales queue-driven workers, and Karpenter supplies
  schedulable node capacity. Taints/tolerations and affinity constrain placement;
  topology spread protects availability across eligible nodes/zones.
- CI security tools must fail distinctly on scanner errors and policy findings;
  missing reports cannot be interpreted as clean results.
- Terraform owns network, EKS, managed data services and registry resources;
  CDK owns its serverless resources. No resource may have both owners.
- Stage 12 remains in progress until the required CI, disposable rollout,
  canary rollback and staging evidence exists. Existing Stage 09–11
  prerequisites remain independently tracked.

## Risks and deferred operator inputs

| Risk / input | Handling |
| --- | --- |
| No disposable Kubernetes runtime is currently available | Start with offline Helm lint/render and manifest assertions; do not claim rollout acceptance. |
| Cloud account, backend state and cost limits are not configured here | Author and validate plans first; apply only after environment ownership, budgets and credentials exist. |
| Existing published images and CI workflow are already modified in this checkout | Preserve the working tree and add gates in focused changes; validate the final workflow before enabling publication. |
| Mesh, DNS, certificate issuer, ingress class and external-secret controller vary by environment | Keep these as explicit profile inputs; do not invent production values. |

## Stage 12.1 implementation

The first slice creates a dashboard-only Helm chart with a digest-pinned image
input, non-root/read-only container, dropped capabilities, resource requests and
limits, health probes, a PodDisruptionBudget, a ClusterIP service, and default-deny network policy
with only explicitly required ingress, DNS, gateway and device/telemetry egress.
Istio injection is opt-in. Optional strict mTLS and workload AuthorizationPolicy
require explicit trusted service principals; the policy is selector-scoped to
this release's dashboard pods. The chart adds narrow control-plane, OTel
Collector OTLP and Prometheus merged-metrics policies when enabled. Application
OTel SDKs export to a separate Collector deployment/agent; an OTel sidecar is
not injected into every app pod. Render checks are static; runtime behavior
waits for a disposable cluster.

The chart now exposes opt-in pod scheduling fields (node selector, affinity,
tolerations, topology spread and priority class) with inert defaults. These
fields make workloads placement-ready without assuming that a target cluster
already has particular node labels, taints, zones or priority classes. The
dashboard itself remains a general-purpose workload; worker node classes and
HPA/KEDA/Karpenter policies belong to the runtime-service and scaling slices.
