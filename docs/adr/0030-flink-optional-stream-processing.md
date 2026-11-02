# ADR-0030: Apache Flink as an optional telemetry stream-processing service

Status: PROPOSED for owner review, 2026-11-01. Implemented locally behind an opt-in profile; nothing is enabled by default. Stage: 10 (technology profiles). Independent of the Intelligence track.

## Context

`greenguard.telemetry.recorded.v1` carries every accepted reading. Today each consumer reads it one record at a time (`packages/kafka-transport` polls 1 and commits per record) and none computes event-time windows, sliding aggregates or per-device anomaly signals. COVERAGE_MATRIX X17 (rollups, late arrivals, event-time processing) is not delivered by a streaming engine, and ADR-0006 states "there is no streaming-engine watermark".

## Decision

Add `services/stream-processor`, a Java 17 Apache Flink 1.20 job that reads `greenguard.telemetry.recorded.v1` and writes three derived topics. It is a read-only side branch of the event backbone:

| Topic | Content |
|---|---|
| `greenguard.telemetry.aggregate.v1` | per-device sliding-window temperature and humidity statistics (revisioned when late data is accepted) |
| `greenguard.telemetry.anomaly.v1` | advisory per-device anomaly signals (z-score and rapid change) |
| `greenguard.stream.dlq.v1` | rejected input and events later than allowed lateness, bounded and tenant-tagged |

Contracts: `contracts/stream/*.schema.json` (kept out of `contracts/events/` so the CDC transformer, which routes by explicit schema map, and the contract suite are untouched).

## What does not change

- The Go CDC transformer, outbox, Debezium connectors, canonical topics, Cassandra writer, search indexer, projection builder and risk engine are untouched. Flink only consumes the canonical topic with its own consumer group (`greenguard-flink-telemetry-v1`). It never writes to an existing topic and never reads or writes any database.
- Derived events are **advisory** (same rule as Intelligence R7): `risk-engine` remains the alert authority. No existing service consumes the derived topics.
- Disabled by default. The Compose services carry the profile `flink`, the Kubernetes manifests are suspended and not referenced from any kustomization or Argo tree, and the topics are created only by `make flink-topics`.

## Semantics

- **Isolation:** every stream is keyed by `tenant_id:device_id`, the Kafka key of the canonical topic. State, windows, timers and output keys never span tenants. The parser rejects a record whose Kafka key disagrees with its tenant and aggregate, or whose `aggregate_id` differs from `payload.device_id` (review H5). Metrics never carry tenant or device labels.
- **Ordering:** a device's records stay in one Kafka partition and one Flink subtask. Within a subtask the anomaly detector releases events in event-time order, using a per-key buffer flushed by watermark timers, so out-of-order arrival inside the watermark bound cannot change detector state.
- **Event time:** `payload.observed_at`. Watermark = max event time minus a bounded out-of-orderness (default 2 minutes) with source-idleness detection so an idle partition cannot stall windows. Aggregate windows allow lateness (default 10 minutes, matching ADR-0006).
- **Late data:** within allowed lateness a window fires again with the same event ID and an incremented `revision`; beyond it the reading goes to the DLQ with reason `late` (it is already in history; this signals only that the streaming result excluded it).
- **Duplicates:** per-device keyed state with a TTL (default 24 h) remembers `event_id`. Replays from Kafka after a failure, or redelivery from the CDC transformer, are dropped once.
- **Delivery:** checkpointing is exactly-once inside Flink. The sink defaults to at-least-once with **deterministic UUIDv5 event IDs**, so consumers de-duplicate through an inbox as required by the architecture invariants. `SINK_DELIVERY=exactly-once` enables Kafka transactions, which then requires `read_committed` consumers and a transaction timeout below the broker maximum.
- **Recovery:** checkpoints every 10 s, externalized and retained, fixed-delay restarts, incremental RocksDB in production profiles. Source offsets live in the checkpoint; the consumer group offset is advisory.
- **Backpressure:** Flink's credit-based flow control; monitored through `backPressuredTimeMsPerSecond`, `busyTimeMsPerSecond`, source lag and checkpoint duration (rules in `infra/flink/prometheus-rules.yml`).

## Consequences and risks

- A new JVM runtime and a new technology family (declared in TECHNOLOGY_CATALOG). The job is not in the SonarQube gate yet: `sonar-project.properties` and the CI workflow do not know Java/Maven. Until a JaCoCo report is wired in, the 80% gate is enforced by the module's own Maven build only.
- The Kubernetes manifest targets the Flink Kubernetes Operator CRD, which cannot be validated offline here.
- Sliding windows multiply state updates by `size/slide` (15 by default); this cost is measured in the benchmark, not assumed.
- Production Kafka security (SASL/TLS) is supported only through pass-through consumer/producer properties and is untested against a secured broker.

## Behaviour confirmed by live testing

- A reading older than the stream's event-time progress is `late` even if its own partition was idle, because downstream operators ignore idle inputs and watermarks never move backwards. Phases of the acceptance test therefore advance event time monotonically.
- The anomaly detector's real-time latency is bounded below by `MAX_OUT_OF_ORDER` because it releases events in event-time order after the watermark.
- Docker treats `docker kill` as a manual stop, so the acceptance test restarts the TaskManager container as an orchestrator would. Compose has no JobManager HA; `infra/flink/restore.sh` restores from the newest retained checkpoint.

## Rollback

See `services/stream-processor/README.md`: stop the job (`make flink-down`), optionally delete the derived topics; no existing component has a dependency to unwind.
