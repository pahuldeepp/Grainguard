# Stage 12 local completion plan

## Context

Continue Stage 12 using local-only implementation and validation. Stage 12's cloud and cluster constraints remain binding; no Terraform apply, shared-cluster deployment, image pull, or paid cloud resource is in scope.

## Global Constraints

- Preserve all pre-existing user changes in this worktree; do not reset, clean, stage, or commit unrelated files.
- Do not commit or push unless the user explicitly asks; the user has now asked for a Stage 12 commit.
- Do not install tools, packages, images, or third-party code. Use locally available dependencies only.
- Treat unavailable Docker/Kubernetes/AWS services as pending evidence, not a pass.
- Keep new changes scoped to files needed for these Stage 12 slices.

## Task 1: Stage 12.12 local resilience evidence and fault checks

Inspect existing retry, timeout, circuit-breaker, rate-limit, idempotency, and fault-injection implementations. Add the smallest missing deterministic local checks and evidence that prove bounded behavior and no duplicate side effects for retryable operations. Do not introduce a new resilience dependency. Document exactly which checks are local and which traffic-policy behavior still needs a disposable mesh/cluster.

Acceptance: local checks have explicit bounded retry/timeout assertions and duplicate-effect assertions; the evidence references commands and outputs; no cluster acceptance is claimed.

## Task 2: Stage 12.13 additional local disaster-recovery procedures

Extend the existing PostgreSQL restore evidence with actionable recovery procedures and a local validation of available backup/restore assets. Exercise only isolated fixtures and already cached local dependencies. Clearly identify service databases, Kafka/Cassandra, managed backups, regional recovery, and measurable RPO/RTO evidence that remain outstanding.

Acceptance: recovery steps name prerequisites, restore order, integrity/isolation checks, and operator decision points; any runnable local check is repeatable and does not touch shared data or pull images.

## Task 3: Stage 12.14 cost and resource governance

Add local resource/cost guardrails for workload requests/limits, replica bounds, worker scaling bounds, and budget ownership/escalation. Add static checks for the enforceable chart/IaC constraints. Do not invent cloud prices or claim observed spend/alerts.

Acceptance: local checks reject at least one invalid resource/scaling configuration and accept supported profiles; documentation distinguishes enforceable local bounds from cloud billing/alert proof still required.

## Task 4: Strengthen Stage 12.8/12.9 local scheduling and scaling validation

Extend offline chart validation for autoscaling min/max bounds, HPA/KEDA ownership, PDB compatibility, compute node taints/tolerations, topology spread, and worker shutdown/recovery evidence. Keep node-failure, drain, multi-AZ, live metrics, Karpenter provisioning, and broker-backed load tests pending.

Acceptance: static gate checks representative valid and invalid profiles and emits clear failures; evidence says which properties are static versus cluster-proven.

## Task 5: Final local Stage 12 gate and status update

Run available non-destructive local/static checks relevant to the completed slices and existing Stage 12 artifacts. Update Stage 12 evidence/status only to reflect proven results. Report all infrastructure-dependent acceptance still pending.

Acceptance: commands/results and blockers are recorded; no infrastructure-dependent criterion is marked complete without its required environment.

Task 5 integration also resolves the known local rehearsal cleanup issue: the PostgreSQL restore script must remove its own anonymous test volumes along with its uniquely named temporary containers before recording the final repeat-run evidence.
