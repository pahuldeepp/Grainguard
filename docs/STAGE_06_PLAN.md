# Stage 06: grain risk, alert lifecycle and notification delivery

Status: implementation starting. The Stage 05b read-version cutover is being validated independently; no Stage 06 completion is claimed here.

06a status (2026-09-24): the risk-engine core is built locally: `greenguard_risk` database, event-time lot join, one-transaction inbox/assessment/outbox apply and a consumer tested against a fake source and live PostgreSQL. See [06a1 evidence](../evidence/STAGE_06A1_VALIDATION.md). Not yet done: live Kafka consumption, CDC publication of the risk outbox, transformer routing of `risk.assessed`, and invalidation after a backdated lot change (no contract).

## End-to-end acceptance

A synthetic, tenant-scoped `telemetry.recorded` event must produce exactly one durable risk assessment, one alert episode and one notification intent. The delivery worker must record one logical delivery despite Kafka/RabbitMQ redelivery. An authorized acknowledgement must transition the alert once, write an audit record and a lifecycle outbox event, suppress a racing escalation, and appear in the read projection. A second tenant cannot read or mutate any of these records. Test process crashes at each database commit / broker acknowledgement boundary, plus provider and dead-letter failures.

## Ownership and sequence

| Slice | Owner | Durable effect and exit proof |
| --- | --- | --- |
| 06a-0 | NestJS device-service | Add tenant-scoped grain lot/batch and its effective bin occupancy interval, with forced RLS, optimistic versioning and transactional `lot.changed`/`lot.retired` outbox events. The existing inventory model currently has sites/bins/devices but no lot table. Route the new events through a dedicated inventory-lot topic so current facility/telemetry consumers need no new event handler. |
| 06a | Python risk-engine | Versioned **grain-type-specific** scoring policies and fixtures; maintain local device binding and bin/lot interval state from inventory events; consume canonical telemetry with manual Kafka commits; select the batch as of the reading's `observed_at` and binding version; transactionally write `(tenant_id, source_event_id, lot_id, policy_version)` assessment, inbox/checkpoint and outbox. Duplicates preserve the original result; invalid measurements are quarantined. |
| 06b | NestJS workflow-alerts | Consume `risk.assessed`; RLS-protected rule/episode tables, source inbox, audit and lifecycle outbox in one transaction. Unique episode key and optimistic versioning cover concurrent scores; authorized acknowledgement has idempotency key and expected version. |
| 06c | Go read projection and search indexer | Project risk and alert lifecycle events with tenant filters, replay and versioned read-view cutover; index alert records, never every raw reading. |
| 06d | jobs-worker dispatcher, RabbitMQ and notification-service | Consume committed alert events into a durable intent/task ledger; publish with confirms; quorum/durable queue profile, bounded retry and DLQ. Provider attempts use a stable task identity, scoped preferences and a test adapter. Ack after durable outcome; replay preserves one logical delivery. |
| 06e | whole flow | Synthetic reading → score → alert → delivery → acknowledgement and suppressed escalation, including restart/redelivery, two tenants, metrics/traces and CI evidence. |

The runtime databases are `greenguard_risk`, `greenguard_alerts`, `greenguard_jobs` and `greenguard_notifications`. Each owner gets separate runtime and migration roles. Tenant tables use forced PostgreSQL RLS **and** tenant filters in application queries. Kafka is the canonical transport between owners; domain writes and outbox inserts share one SQL transaction. CDC publishes outbox rows after commit. RabbitMQ carries retryable delivery tasks, not authoritative alert state.

Workers have separate bounded pools for scoring, alert transitions, dispatch and provider calls. A slow provider cannot consume scoring or acknowledgement capacity. Each pool sets a maximum in-flight count, timeout, queue/lag alarm and per-tenant fairness or quota; broker offsets/acknowledgements advance only after the owner's durable effect. Shed or pause at a documented bound instead of growing memory without limit. Record end-to-end reading-accepted → alert-visible latency and delivery latency separately; Stage 13 must measure the fleet target under load.

## Contracts and invariants

`greenguard.risk.assessment.v1` contains `risk.assessed` (or `risk.assessment_invalidated`) with source reading ID, policy/model version, a bounded score, severity and input reason codes. The envelope keeps tenant, aggregate, correlation, causation and trace identity. The risk result is a deterministic function of a versioned policy and accepted measurement values; clinical scores and model artifacts are never reused as agricultural policy.

**Event-time grain join:** telemetry stays generic: it already carries tenant, device, bin, binding version and `observed_at`. A separate `greenguard.inventory.lot.v1` stream carries tenant/bin/lot identity, grain type, occupancy `effective_from` and monotonic occupancy versions. The next version closes the prior interval at its `effective_from`; no `effective_to` field is present in `lot.changed`. Risk retains those derived effective intervals and selects the one covering the reading's observed time, not the batch present when Kafka delivers the reading. The resulting assessment records the chosen lot, grain type, occupancy version and policy version so a replay is explainable. One active batch per bin is the initial explicit invariant; mixtures require a new model/contract. Missing, overlapping or stale context fails closed into a bounded pending/reconciliation path and cannot emit an alert using a guessed crop. Late lot/binding events trigger bounded re-evaluation or an explicit invalidation event. Tests cover wheat→canola replacement and late wheat telemetry after replacement.

The dedicated lot topic avoids changing existing telemetry, Cassandra and current read-projection consumers. It still requires inventory ownership, an outbox/CDC mapping, topic/schema provisioning and the risk consumer. If a lot event is instead added to the existing shared facility topic, every consumer of that topic must explicitly handle or safely ignore it before rollout.

`greenguard.alerts.lifecycle.v1` contains `alert.opened`, `alert.updated`, `alert.acknowledged`, `alert.escalated` and `alert.resolved`. An episode is keyed by tenant, rule, monitored resource and open window. Its version is monotonic. Acknowledgement and escalation contend on that same version/row lock; a stale escalation records a no-op receipt rather than reopening an acknowledged alert. A command timeout alone is not a completed rejection.

Notification intent has a stable ID derived from the committed alert transition. Provider attempts may repeat, but the local delivery ledger has one terminal logical result. Provider APIs that lack idempotency keys require reconciliation after an uncertain outcome; a timeout must not be silently treated as failed or retried without bounds. The initial local adapter records delivery without external messages.

## Gates

1. Contract schemas and fixture compatibility: valid/invalid, old/new versions, wrong tenant/key, source correlation and deterministic replay.
2. Unit tests: risk boundaries/missing values, rule threshold/hysteresis, acknowledgement races, duplicate event/command, escalation suppression, retry schedule.
3. Live database tests: forced RLS, two tenants, role limits, transaction rollback after outbox/inbox, concurrent updates and replay.
4. Live transport tests: Kafka redelivery/crash, CDC publication, RabbitMQ confirm/ack/DLQ failures, provider timeout and replay.
5. `make verify`, coverage/Sonar gate, CodeRabbit review, local E2E evidence, then remote CI before the tracker says complete.

Stage 07 owns cross-service provisioning sagas. Stage 08 owns GraphQL/BFF and dashboard alert UI. Stage 10 owns production provider adapter breadth and the isolated clinical reference lab. Stage 13 owns large-scale and multi-node resilience certification.
