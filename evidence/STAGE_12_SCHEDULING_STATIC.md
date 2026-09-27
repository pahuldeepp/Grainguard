# Stage 12.8/12.9 — scaling, scheduling and shutdown local record

Updated: 2026-09-27

The runtime service profiles render optional node selectors, affinity,
tolerations, topology spread, priority class, PDB and termination grace fields.
Worker profiles target the compute workload class and its taint. The hardware
worker process now cancels sibling loops on worker failure and waits up to
30 seconds for them to stop before returning and closing shared clients. MQTT
acknowledgements use a persistent QoS 1 session, serial handling, explicit
SUBACK checks and manual acknowledgement after the database transition
commits. The worker waits for its subscription before starting worker loops.
Acknowledgement database work has a 10-second deadline; errors force a broker
reconnect through a bounded retry supervisor so uncommitted QoS 1 messages can
be redelivered.
The worker requires an explicit stable, unique `MQTT_CLIENT_ID` per replica
and rejects startup when it is absent; there is no process-ID fallback.
Configure persistent broker storage in production.

Local validation on 2026-09-27:

- `bash scripts/helm-validate.sh` passed. Its structured YAML checks inspect the
  Deployment, HPA/ScaledObject and PDB separately for all ten runtime service
  profiles and three worker profiles. HTTP HPA profiles render bounds 2–10,
  CPU utilization 70%, a 300-second scale-down stabilization window and no
  Deployment replica count. Fixed service profiles render two replicas; fixed
  workers render one. Each autoscaler targets its Deployment by name, kind and
  API version, with no other replica owner. HPA requires explicit `apps/v1`
  and `Deployment`; KEDA's omitted fields resolve to the same documented
  defaults ([KEDA specification](https://keda.sh/docs/2.21/reference/scaledobject-spec/)).
  Mutated target kind and API version fail specifically for both owners;
  mutated HPA metric type, resource name and target type also fail. HPA CPU
  metrics require `Resource`, `cpu`, `Utilization` and utilization 70%. PDB selectors match the workload and `minAvailable` remains
  below its minimum replicas.
- Positive boundary fixtures render HPA 1–2 with PDB disabled, KEDA 0–3 with
  PDB disabled, KEDA 2–3 with a compatible PDB, and KEDA 1–12. Negative fixtures
  reject equal/reversed HPA and KEDA bounds, HPA minimum zero/maximum one,
  KEDA minimum negative/maximum zero, HPA/KEDA overlap, KEDA without a trigger,
  HPA on a non-HTTP worker, and PDBs that block the scaling minimum. These are
  schema/template limits, not live autoscaler decisions or capacity ceilings.
- All three worker profiles select `greenguard.io/workload-class: compute`
  and tolerate that exact key/value with `Equal` and `NoSchedule`, matching the
  compute pool taint declared in `infra/terraform/platform/main.tf`. Workers
  render a 60-second termination grace; other runtime profiles render 30.
  Zero and 601 seconds are rejected by the schema's 1–600-second range.
- An optional worker fixture renders priority class `greenguard-compute` and
  zone topology spread with `maxSkew: 1`, `DoNotSchedule`, and labels matching
  its Deployment. Deliberate node selector, toleration, spread, priority and
  shutdown-grace drift each fail with the expected diagnostic. Default
  profiles keep topology spread and priority disabled. Rendering does not
  prove that the named PriorityClass or eligible zones exist.
- `go test -race ./cmd/worker -run
  'Test(RunRequiresDatabaseAndBroker|RunWorkers|MaintainMQTTConnection|SubscribeAck|MQTTSubscription)'
  -count=1` passed without cached results (review rerun: `1.452s`). It covers
  rejection of missing MQTT client ID, cancellation/join,
  sibling cancellation on error, preserving errors during shutdown,
  unexpected loop exit, subscription retry/cancellation, broker subscription
  refusal handling, and reconnect supervisor behavior using local fakes.
  `go test -race ./...` in `services/hardware-service` also passed (cached).
  Broker/database integration cases remain environment-gated; this command
  is not evidence of broker redelivery or persistence after a node failure.

These are offline render and process-level results. No Kubernetes cluster was
used. Node failure, node drain, multi-AZ/zone loss, PDB enforcement, rescheduling,
real shutdown/checkpoint recovery, live CPU/lag metrics, KEDA behavior under
broker-backed load, and Karpenter provisioning remain pending. Stage 12.8 and
12.9 remain in progress; this record does not close their cluster acceptance.
