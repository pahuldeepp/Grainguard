# Disposable AWS capacity preflight

`capacity-preflight.tf` reads the selected region's approved EC2 standard
On-Demand vCPU quota, RDS instance quota, and EC2 instance-type metadata during
Terraform plan. Output preconditions reject a plan whose configured managed-node
maxima or database count exceed those quotas, before apply creates infrastructure.

The current calculation includes:

- general managed nodes: maximum count × largest allowed instance's vCPUs;
- compute managed nodes: maximum count × largest allowed instance's vCPUs;
- AI parser managed nodes when enabled: two `m6i.large` instances;
- central PostgreSQL plus four shard primaries and configured shard replicas.

With the checked-in defaults and AI enabled this requires 32 standard On-Demand
vCPUs and nine RDS instances. The 2026-10-12 account check found 8 vCPUs and 40
RDS instances in `us-east-2`; request `3993b1908ca34478b81df8116a11b1059gaZ54fV`
asks for 32 vCPUs and was pending when recorded. Recheck the approved quota before
apply. Request submission is not approval and does not launch instances.

This check does not account for instances used by other workloads, rolling-update
surge, or new Karpenter NodePool limits. Karpenter wiring must extend the capacity
calculation before its autoscaling acceptance gate can pass. The quota check also
does not guarantee EC2 availability in an AZ, RDS provisioning, workload health,
throughput, or SLOs; those still require live acceptance.

## Offline proof

### Eight-vCPU feasibility (2026-10-12)

The owner authorized a smaller first deployment, retaining every service and
security control. Before changing node counts, run:

```sh
ruby infra/terraform/disposable/minimum-capacity.rb
ruby infra/terraform/disposable/test-minimum-capacity.rb
```

This deliberately optimistic lower bound reads the required release inventory,
merges each chart's base/profile resource requests, assumes only **one** pod per
application, reads the proxy CPU request from the pinned Istio chart, and retains
the existing Kafka/RabbitMQ/Redis Cluster topology. It currently reports:

| Subset | Requested CPU |
| --- | ---: |
| 33 application containers, one each | 3.375 vCPUs |
| Their mandatory Istio proxies | 3.300 vCPUs |
| Kafka, RabbitMQ, six Redis nodes | 1.350 vCPUs |
| Partial lower bound | **8.025 vCPUs** |

That already exceeds eight physical vCPUs. Cassandra, OpenSearch, ClickHouse,
Connect, registry, PgBouncer, Dex, AI/ML, observability, controllers, DaemonSets,
node reservations and transient jobs/surge are **additional**. Node sizing with
more memory cannot fix this CPU scheduling deficit. Dedicated compute/parser
placement also needs separate packing analysis.

No replica, CPU request, security setting or deployment scope was reduced, and
no AWS apply was run. This is a static rejection of the current resource requests,
not a claim that every conceivable optimized implementation requires this CPU.
Reducing CPU requests needs measured low-load/startup evidence first. Until that
exists or the approved quota increases, the requested complete deployment has
not demonstrated a safe fit. Keep KEDA and Karpenter wiring; their future scaling
ceilings must count against the approved quota rather than assuming extra capacity.

After initializing the disposable root's pinned providers:

```sh
python3 -m unittest infra/terraform/disposable/test_capacity_preflight.py -v
```

The test copies the actual quota calculation and output-precondition code into a
fixture using Terraform's mocked AWS provider. Five scenarios cover supported
capacity, insufficient CPU/RDS quotas, empty instance types and a mocked apply.
A separate fixture exercises the actual output preconditions with variable-based
quota metadata and only a built-in Terraform state placeholder, proving destroy
still succeeds when the quota drops. Neither fixture provisions AWS resources.
The disposable lifecycle audit remains unchanged and must stay green.
