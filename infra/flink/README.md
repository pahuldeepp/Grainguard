# infra/flink

Optional deployment of `services/stream-processor` ([ADR-0030](../../docs/adr/0030-flink-optional-stream-processing.md)). **Disabled by default** and unreferenced by every default stack; `make flink-check` enforces that.

| File | Purpose |
|---|---|
| `compose.yaml` | JobManager and TaskManager, both in the `flink` profile only; loopback ports; all capabilities dropped |
| `compose.standalone.yaml` | Self-contained single-broker Kafka (127.0.0.1:59192) for tests and benchmarks |
| `topics.sh` | Creates the derived topics (idempotent) |
| `restore.sh` | Restarts the JobManager from the newest retained checkpoint after a JobManager loss |
| `prometheus-rules.yml` | Alert rules for job health, checkpoints, restarts, backpressure, lag, rejections, watermarks |
| `k8s/` | Flink Kubernetes Operator `FlinkDeployment` (suspended), RBAC, NetworkPolicy, Kustomization; not part of any Argo tree |
| `check-manifests.rb` | Static guards (profile gating, loopback, suspended, digest placeholder, no references) |

Production enablement requires all gates in [the integration runbook](../../docs/runbooks/flink-risk.md); local evidence is not production approval. The opt-in CI workflow runs unit/coverage and monitoring checks on relevant PRs. Its `workflow_dispatch` live input defaults to false; an explicit true runs a fresh disposable test stack, retains evidence and tears down only its owned project. This workflow has not yet been executed on GitHub.

`risk-prometheus-rules.yml` adds flag-aware risk consumer rules; `risk-prometheus-rules.test.yml` proves enabled/disabled behavior with promtool.

Enable on Kubernetes after approval: build and sign the image, replace the digest and the `REPLACE_*` values, install the operator, `kubectl apply -k infra/flink/k8s`, then change `job.state` to `running`.
