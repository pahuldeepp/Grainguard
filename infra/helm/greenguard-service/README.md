# GreenGuard runtime-service chart

This chart provides hardened Deployments, optional ClusterIP Services,
ServiceAccounts, optional PodDisruptionBudgets and default-deny NetworkPolicies.
Ten HTTP profiles are included for gateway, device-service, read-api,
workflow-alerts, telemetry-ingest, cdc-transformer, projection-builder,
cache-invalidator, risk-engine and saga-api. Three worker profiles cover
hardware-service-worker, eventbridge-bridge and saga-worker. HTTP ports and
health paths come from their current Dockerfiles and health handlers. Saga API
health checks use TCP because its HTTP health endpoints require client mTLS;
this verifies the listener is accepting connections, not its database health.

The five synchronous HTTP profiles (gateway, device-service, read-api,
workflow-alerts and telemetry-ingest) enable an `autoscaling/v2` HPA with a
two-pod minimum, ten-pod maximum and 70% CPU target. The Deployment omits its
replica field whenever HPA or KEDA owns scaling. The KEDA `ScaledObject` is
available for queue-driven workers; configure each Kafka trigger's real broker,
topic, group, authentication reference, lag threshold and min/max against the
target cluster. No broker endpoint or credentials are guessed in chart values.

Supply a published immutable image digest with `--set-string image=...` for
every release. The profiles intentionally contain no image digest or
credentials. Provide secrets through environment-specific Secret references in
`container.env` or `container.envFrom`; do not commit credential values.
Configure NetworkPolicy ingress and `networkPolicy.egressServices`/`egressCIDRs`
using the real peer namespace, labels, endpoints, and ports before deployment.
Empty egress lists do not permit backend connectivity.
Ingress peers default to an empty list. The `gateway` profile alone allows the
Istio ingress gateway, while device/telemetry profiles allow the dashboard
reverse-proxy workload and Read API/alerts profiles allow their declared
gateway/BFF callers. Confirm every release name and selector against the
deployed workloads before rollout.

Worker profiles disable Services and HTTP probes, enforce the `compute` node
selector and taint toleration, deny inbound pod traffic, and allow 60 seconds
for termination (the hardware worker uses its checkpoint grace period). Their
environment needs explicit egress rules for Kafka, PostgreSQL, MQTT, and AWS
endpoints. Single-replica workers have PDBs disabled
so they cannot block drains. Installing and configuring the HPA metrics source
and KEDA controller, then proving pod and node scaling, remain later Stage 12
work.

Run `make helm-validate` from the repository root to lint and render every
profile. These offline checks do not prove network paths, image availability,
admission behavior, or rollout health in Kubernetes.
