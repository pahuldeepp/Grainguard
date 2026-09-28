# Stage 13 — capacity, soak and failure certification

Stage 13 remains **planned**. The [capacity model](CAPACITY_MODEL.md) is
arithmetic, not measured throughput. The disposable AWS cell is a functional
acceptance target, not a certification of the Tier 1 workload in
[`CAPACITY_MODEL.md`](CAPACITY_MODEL.md) or the 10-million-user design target.
Tier 1 calls for a joint 100k-user/10k-tenant/1M-device load, 20k normal and
50k peak events per second, a 24-hour soak and separate 30-day availability
evidence. None of those measurements currently exists.

## Pre-AWS work

1. Define a bounded, reproducible workload covering browser and mobile login,
   device ingest, read freshness, alert creation, live update and ACK. Use
   isolated tenants and record the data seed and cleanup owner.
2. Make generators report offered and completed rates, latency distributions,
   errors, retries, Kafka/RabbitMQ lag, queue drain time and resource usage.
3. Define an abort condition and a cost/time ceiling for the disposable cell.
   Record the expected minimum/maximum pod and node counts before running.
4. Review fault scripts so they target only the named disposable environment,
   restore every changed setting and cannot affect production.
5. Run the local script/unit checks and static chart/CI checks. Keep any result
   labeled local until a real cluster has been exercised.

## Live disposable-cell acceptance

The [functional and physical iPhone runbook](runbooks/disposable-live-acceptance.md)
defines the minimum deployed journeys and a fail-closed, offline evidence
inventory check. It has no live evidence yet and does not certify the load,
soak or availability targets below.

| Exercise | Required observation |
| --- | --- |
| Baseline load | Web/API and event journeys succeed within approved SLOs; error, latency, saturation and cost are recorded. |
| Backlog burst and drain | KEDA workers grow within bounds; lag drains without duplicate external effects; workers return to the approved floor. |
| HTTP burst | HPA scales API replicas within bounds; Karpenter adds schedulable capacity when needed; scaling does not bypass PDB or zone placement. |
| Soak | Sustained workload has no unbounded queue, memory, connection, cost or error growth; data reconciliation passes afterward. |
| Node/AZ fault | Critical replicas reschedule, requests recover, consumers resume at a safe checkpoint and alerts remain observable. |
| Dependency fault | Bounded timeouts/retries and circuit behavior protect callers; replay/idempotency prevent duplicate writes after recovery. |
| Canary failure | Argo analysis rejects the bad revision and traffic returns to the last healthy digest. |
| Teardown | All workload, controller and data owners are removed before EKS/VPC; the final inventory reports any surviving chargeable resource. |

Capture exact commands, tested image digests, Terraform state identity,
environment/account/region, workload parameters, start/end times, dashboard
queries, raw output and cleanup results under `evidence/`. Approve workload
targets and SLOs before claiming Stage 13 certification. See the
[pre-AWS audit](../evidence/STAGE_11_12_13_PRE_AWS_AUDIT.md) for current gaps.
