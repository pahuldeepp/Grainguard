# Stage 12.6 — GitOps and progressive delivery static evidence

Date: 2026-09-26

## Implemented

The dashboard Helm chart supports two mutually exclusive workload shapes:

- Default: `apps/v1` Deployment with bounded rolling update.
- Opt-in: `argoproj.io/v1alpha1` Rollout with 25% and 50% canary steps,
  60-second pauses and Prometheus analysis after each pause.

The opt-in mode requires an immutable image digest (shared chart contract) and
non-empty Prometheus address and success-rate query. Its AnalysisTemplate
checks the configured success-rate threshold, interval, count and failure
limit. Chart documentation explains the required environment-specific query
and that the Argo Rollouts CRDs/controller and Prometheus are external
prerequisites.

## Static validation

`make helm-validate` passes. In addition to normal chart lint/render checks, it:

- confirms the default profile remains a Deployment;
- rejects rollout mode without Prometheus analysis configuration;
- renders rollout mode with a syntactic test query and confirms Rollout,
  AnalysisTemplate, weights and threshold are present.

The test query `vector(1)` is only a manifest-render fixture. It does not prove
that a live success-rate query is meaningful. This checkout has no configured
Kubernetes context, so Argo CD promotion, metric failure, abort and rollback
have not been exercised. Stage 12.6 remains in progress.
