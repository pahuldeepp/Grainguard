# services/stream-processor

Status: **optional, disabled by default** ([ADR-0030](../../docs/adr/0030-flink-optional-stream-processing.md)). Unit and live local acceptance pass (`make flink-test`, `make flink-e2e`); it is **not** in CI, the Sonar gate or any default Compose/Helm/GitOps path, and has never run against a secured broker or on Kubernetes.

Technology: Java 17, Apache Flink 1.20.1, `flink-connector-kafka` 3.4.0-1.20, Maven. Reads `greenguard.telemetry.recorded.v1` (canonical, produced by the Go CDC transformer) with its own consumer group and writes three derived topics. It never touches a database, an existing topic or an existing consumer group.

```text
telemetry.recorded.v1 ─► parse+validate ─► dedupe(event_id) ─┬► sliding window 15m/1m ─► telemetry.aggregate.v1
   (6 partitions)          │ rejected                         ├► anomaly detector ──────► telemetry.anomaly.v1
                           └──────────────────────────────────┴► late (> allowed lateness) ► stream.dlq.v1
```

## What it computes

| Output | Meaning |
|---|---|
| `telemetry.aggregate.v1` | Per device and window: reading count and min/max/mean of temperature and humidity. Sliding windows of `WINDOW_SIZE` every `WINDOW_SLIDE` (default 15 m / 1 m). Accepted late data refires the window with the **same `event_id` and a higher `revision`**; consumers keep the highest revision. |
| `telemetry.anomaly.v1` | Advisory signals only (`risk-engine` stays the alert authority): `zscore` (EWMA baseline, default 4 sigma after 30 samples) and `rapid_change` (default 5 C/min or 10 %/min within 10 min). Per-metric cooldown (default 5 min of event time); a sustained shift is relearned after 10 outliers. |
| `stream.dlq.v1` | `bad_json`, `bad_envelope`, `bad_field`, `key_mismatch` and `late` (a reading beyond allowed lateness: it is already in history, only the streaming result excludes it). Raw bytes bounded to 64 KiB, 7-day retention; ACL-restrict in production. |

Contracts: [`contracts/stream/`](../../contracts/stream). Event IDs are UUIDv5, so replay and restart reproduce identical IDs and byte-identical payloads; downstream consumers must still de-duplicate through an inbox (the sink is at-least-once unless `SINK_DELIVERY=exactly-once`).

## Guarantees and how they were checked

| Property | Mechanism | Evidence |
|---|---|---|
| Tenant isolation | Everything is keyed by `tenant_id:device_id`; the parser rejects a Kafka key that disagrees with the body and `aggregate_id != payload.device_id`; no metric label carries tenant or device | Unit + pipeline tests with the same device UUID under two tenants; live check A3 |
| Ordering | One partition and one subtask per device; the anomaly detector buffers and releases events in event-time order on watermark | `OperatorsTest.outOfOrderArrivalIsProcessedInEventTimeOrder` |
| Event time and late data | `observed_at`, per-partition bounded out-of-orderness (2 min) with idleness (30 s), allowed lateness 10 min | `PipelineTest` (refire with revision 2, DLQ beyond lateness); live A1, A5 |
| Duplicates | Keyed `event_id` state with a 24 h TTL | Unit, pipeline and live A1 (duplicates counted once), C3 (dedupe state survives restore) |
| Failure recovery | Exactly-once checkpoints every 10 s, externalized and retained, exponential-delay restarts | Live B1 (TaskManager killed), C1-C3 (JobManager lost, restore from newest checkpoint) |
| Backpressure and monitoring | Credit-based flow control, buffer debloating; Prometheus reporter on :9249; rules in [`infra/flink/prometheus-rules.yml`](../../infra/flink/prometheus-rules.yml) | Metric names verified against a running cluster; alert delivery not exercised |

## Run

```bash
make flink-test      # Maven verify in Docker: 38 tests, 80% line-coverage gate (JaCoCo)
make flink-check     # static guards: disabled by default, loopback only, unreferenced
make flink-up        # isolated project gg-flink: own Kafka (127.0.0.1:59192), JobManager, TaskManager, UI on 127.0.0.1:58084
make flink-e2e       # live acceptance: semantics, TaskManager loss, JobManager loss + restore
make flink-bench     # benchmark against Go consumers (see docs/FLINK_BENCHMARK.md)
make flink-down
```

Next to the real event stack instead: `docker compose --env-file .env -f infra/compose/compose.yaml -f infra/kafka/compose.yaml -f infra/flink/compose.yaml --profile flink up -d`, then `infra/flink/topics.sh "<same compose command>"` to create the derived topics.

Configuration is environment-only (see `Config.java`): `KAFKA_BROKERS` (required), `PARALLELISM`, `MAX_OUT_OF_ORDER`, `IDLE_TIMEOUT`, `ALLOWED_LATENESS`, `WINDOW_SIZE`, `WINDOW_SLIDE`, `DEDUPE_TTL`, `CHECKPOINT_INTERVAL`, `CHECKPOINT_DIR`, `STATE_BACKEND` (`hashmap` or `rocksdb`), `SINK_DELIVERY`, `ANOMALY_*`, and `KAFKA_PROP_SECURITY_PROTOCOL` / `KAFKA_PROP_SASL_*` / `KAFKA_PROP_SSL_*` pass-through. Invalid values fail startup.

## Behaviour you need to know

- **Anomaly latency is at least the out-of-orderness bound.** Events are released in event-time order only after the watermark passes them, so with production traffic (event time close to wall time) an anomaly appears about `MAX_OUT_OF_ORDER` (default 2 min) after the reading. Lower the bound to trade ordering safety for latency. Measured numbers are in `docs/FLINK_BENCHMARK.md`.
- **Idle inputs and late data.** Downstream operators ignore idle partitions, and watermarks never move backwards. A reading far older than the stream's progress (for example a backfill after other devices advanced hours) is classified `late` and goes to the DLQ. It is still in history; use the history path to backfill.
- **Sliding windows multiply state updates by `size/slide`** (15 by default).
- **Compose has no JobManager HA.** A lost JobManager loses the job; `make flink-restore` restarts it from the newest retained checkpoint (verified, about 45 s). Kubernetes uses operator HA with `upgradeMode: last-state`. Restarting a killed container is the orchestrator's job (`docker kill` is treated by Docker as a manual stop).
- **State TTL is processing-time based.** Replaying a very old backlog quickly keeps more dedupe state than the TTL suggests; size RocksDB accordingly.

## Rollback

Nothing else depends on this service, so rollback never touches existing components:

1. **Stop:** `make flink-down` (Compose), or set `job.state: suspended` on the `FlinkDeployment` (Kubernetes). Derived topics simply stop receiving data.
2. **Optional cleanup:** delete the consumer group `greenguard-flink-telemetry-v1`, the three derived topics (`kafka-topics.sh --delete`) and the `gg-flink_flink-checkpoints` volume or the checkpoint bucket prefix.
3. **Bad release of this job:** take a savepoint, deploy the previous image digest from that savepoint (operator `upgradeMode: savepoint`). All operators have stable `uid`s, so state restores across compatible versions; if it does not, deploy with a new consumer group to reprocess from the retained input topic (aggregates are idempotent by event ID and revision).
4. **Remove from the repository:** revert the commit; no migration, default topic, default Compose service or Helm value was added.
5. **Verify:** `make flink-check` fails if anything outside `infra/flink/` starts referencing the deployment.

## Not done / known gaps

Not wired into CI or SonarQube (no Java/JaCoCo analysis in `sonar-project.properties`); the Flink Kubernetes Operator manifest and NetworkPolicy have only been parsed, not applied; no test against a TLS/SASL broker or RF3 cluster; no exactly-once sink test (`SINK_DELIVERY=exactly-once` builds but was not run live); alert rules were checked for metric names, not fired; throughput numbers come from one shared Docker Desktop VM.
