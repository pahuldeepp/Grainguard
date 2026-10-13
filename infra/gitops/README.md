# infra/gitops

Status: **partial implementation; cluster acceptance pending**.

Stages: 12.

Technology: ArgoCD, Argo Rollouts.

Responsibility: Immutable image promotion and metric-backed canary rollback.

The dashboard Helm chart now has an opt-in Argo Rollouts mode with digest-only
images, weighted canary steps, pauses, and a required Prometheus success-rate
AnalysisTemplate. See `infra/helm/greenguard-dashboard/README.md`. Offline Helm
render checks validate the Rollout and analysis gate and reject enabling canary
mode without an explicit metric query. Argo Rollouts and Prometheus are not
installed by this repository profile, and no rollback has been observed in a
cluster yet; 12.6 remains incomplete until a failed metric analysis aborts and
rolls back a disposable release.

Implement the linked requirements in the main coverage matrix and backlog. Completion requires runtime wiring, meaningful tests, relevant failure/tenant isolation evidence, and reproducible local/CI commands. Existing source reference archives live outside this fresh project.
