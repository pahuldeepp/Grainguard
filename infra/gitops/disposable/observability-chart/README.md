# Disposable observability owner

The pinned Argo child Application at sync wave 15 owns one OpenTelemetry
Collector, Prometheus, Grafana, Tempo and Loki Deployment and private
`ClusterIP` Service each. The Terraform-owned root Application supplies exactly
five OCI digests; the chart rejects missing or mutable images. Argo prunes
these namespaced resources during teardown through its finalizer. Terraform
retains ownership of the root Application and EKS cell.

This is a small disposable backend only. The runtime values enable OTLP/HTTP
trace export on the seven services that currently read `OTEL_EXPORTER_OTLP_ENDPOINT`;
they use the collector's port 4318. Other services do not become instrumented
merely by setting a standard environment variable. Prometheus discovers
`greenguard` pods with `prometheus.io/scrape=true` and scrapes their merged
Istio metrics on port 15020. It also scrapes the gateway's separate application
RED listener on port 9464. That target is enabled only by explicit pod
annotations; Prometheus has an injected Istio sidecar and the gateway accepts
the metrics port only from the Prometheus service-account principal under
strict mTLS. The gateway NetworkPolicy independently allows only the Prometheus
pod selector on that port. No public Service or ingress exposes it. Prometheus's dedicated ServiceAccount has only namespaced
pod get/list/watch access; it needs an API token for Kubernetes discovery.
NetworkPolicies permit runtime OTLP ingress to the collector, collector export
to Tempo and Loki, and Prometheus scrape ingress to the collector. Prometheus
and Grafana still use the namespace's default egress policy; this chart does
not claim an exhaustive observability firewall. Tempo, Loki, Prometheus and Grafana use bounded
`emptyDir` storage, so restarting a pod can erase their data. The services
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
