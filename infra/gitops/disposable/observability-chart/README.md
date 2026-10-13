# Disposable observability owner

The pinned Argo child Application at sync wave 15 owns one OpenTelemetry
Collector, Prometheus, Grafana, Tempo and Loki Deployment and private
`ClusterIP` Service each. The Terraform-owned root Application supplies exactly
five OCI digests; the chart rejects missing or mutable images. Argo prunes
these namespaced resources during teardown through its finalizer. Terraform
retains ownership of the root Application and EKS cell.

This is a small disposable backend only. It persists Prometheus TSDB data to a
30 GiB encrypted gp3 claim with a 35-day time retention and a 24 GB size cap.
The disposable-data Argo application installs the matching
`greenguard-disposable-gp3` StorageClass first; its Delete reclaim policy and
the observability Application finalizer remove the claim during teardown.
Retention under actual metric cardinality/load still needs measurement; the
size cap may evict older samples sooner if series volume is too high. The SLO
rules now withhold the 30-day error-budget panel and raise
`SLOHistoryWindowUnavailable` until Prometheus proves it retained a full window.
Tempo, Loki and Grafana remain bounded `emptyDir` stores. This is not production
observability or a guarantee of 30-day evidence until live retention is verified.

The chart provisions the shared Stage 11 30-day SLO rules with the synthetic
ML scoring rules. Alertmanager delivery is not included in this small stack:
rules can evaluate in Prometheus, but notification routing needs separate
deployment and live acceptance.

The runtime values enable OTLP/HTTP
trace export on the seven services that currently read `OTEL_EXPORTER_OTLP_ENDPOINT`;
they use the collector's port 4318. Other services do not become instrumented
merely by setting a standard environment variable. Prometheus discovers
opt-in `greenguard` pods and uses port 15020 for services whose original
`/metrics` endpoint is merged by Istio, and port 15090 for Envoy-only targets.
The `job` label is rewritten to the Argo release name so the shared SLO selectors
match `telemetry-ingest`, `device-service`, and other application metrics. It
also scrapes the gateway's separate application
RED listener on port 9464. That target is enabled only by explicit pod
annotations; Prometheus has an injected Istio sidecar and the gateway accepts
the metrics port only from the Prometheus service-account principal under
strict mTLS. The gateway NetworkPolicy independently allows only the Prometheus
pod selector on that port. No public Service or ingress exposes it. Prometheus's dedicated ServiceAccount has only namespaced
pod get/list/watch access; it needs an API token for Kubernetes discovery.
NetworkPolicies permit runtime OTLP ingress to the collector, collector export
to Tempo and Loki, and Prometheus scrape ingress to the collector. Prometheus
and Grafana still use the namespace's default egress policy; this chart does
not claim an exhaustive observability firewall. Tempo, Loki and Grafana use
bounded `emptyDir` storage, so restarting a pod can erase their data. The services
have no public ingress. Grafana requires the `grafana-admin` Kubernetes Secret
with `GF_SECURITY_ADMIN_USER` and `GF_SECURITY_ADMIN_PASSWORD`, populated by
the out-of-band secret sync path. Anonymous signup is disabled.

Run `ruby infra/gitops/disposable/check-observability.rb` for an offline
render and negative digest checks. Cluster health, image availability, OTLP
delivery, pod scraping, dashboard/rule provisioning, retention under load,
all network peers and alert routing remain live Stage 11 acceptance work. Do not
use this chart as proof of full production observability.

The synthetic-only ML scorer dashboard/rules are provisioned into this same
stack. Its PSI gauge remains absent until the model bundle's minimum 512
accepted feature observations are accumulated. The local scorer acceptance
proves OTLP transport for metrics, traces, and logs; deterministic Prometheus
rule tests separately validate PSI alert behavior. The 30-minute firing
duration is not claimed as live-fire tested by the 24-event scorer acceptance.
