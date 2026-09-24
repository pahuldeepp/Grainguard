# ADR-0009: source checkpoints and binding-feed admission

Status: implemented; passed local single-broker live acceptance (`make events-e2e`). Production readiness not claimed.

## Authority and admission

FIRST_VERTICAL_SLICE sections 2 and 5A govern this decision. Every **new
observation**, including one from an existing device, requires an active binding
and fresh feed. An authenticated identical receipt returns before the binding and
freshness checks. Missing bindings retain `409 device_not_ready`; disabled bindings
retain the existing denial. No interpretation of “new device” exempts subsequent
observations from delayed-disable protection.

`INGEST_BINDING_FEED_MAX_STALE` defaults to `5m`; explicit `0` disables this gate.
With Kafka configured, missing or expired evidence fails closed with
`503 binding_feed_stale` and `Retry-After: 5`. Without `KAFKA_BROKERS`, the consumer
and gate are skipped to preserve the existing standalone development behavior.

## Heartbeat protocol

The earlier documents specify source progress but omit the wire protocol. The
follow-up instruction permits the proposed ADR choices where the slice is silent.
This implements the minimal connector/transformer extension needed for that proof:

1. Every 30 seconds, the inventory connector's heartbeat action executes
   `pg_logical_emit_message(true, 'greenguard.binding-feed', 'checkpoint')`.
   This creates a transactional WAL marker without writing another owner's tables
   or introducing a database/broker dual write. The connector routes its `.message`
   topic and inventory outbox topic into the same **single-partition raw topic**.
2. The transformer recognizes only transactional `op=m` records with the expected
   prefix/database, positive source LSN, transaction ID and source commit timestamp.
   It uses `source.ts_ms`, never connector processing time or current local time.
   Debezium's PostgreSQL connector documents transactional message ordering and
   heartbeat actions in its [PostgreSQL reference](https://debezium.io/documentation/reference/stable/connectors/postgresql.html).
3. Its existing sequential processor publishes the checkpoint to each of the
   **six canonical partitions**, synchronously, before committing the raw offset.
   Earlier domain publications have already received acknowledgements. Keyed domain
   records retain the Kafka-compatible keyed hash; checkpoints select partitions
   explicitly. Partition-count drift prevents successful checkpoint publication.
4. Each checkpoint has key `binding-feed-checkpoint`, event type
   `binding.feed_checkpoint`, schema version 1, UTC `source_time`, decimal WAL
   `source_position`, covered `raw_position`, and `partitions=6`. It is infrastructure
   control data, not a tenant inventory event. The consumer commits its offset only
   after persisting the checkpoint. Replay never substitutes a newer local clock.

Preconditions: retain the provisioned one raw/six canonical partitions, one inventory
connector task, ordered source publication, and broker ACLs restricting publication
to the owning connector/transformer. Changing topology or recreating topics is an
operational migration, not an online setting change. No independent heartbeat topic,
consumer poll, last device-event time or broker ping proves binding freshness.

## Persistence and clock bounds

Migration 000004 adds telemetry-owned `binding_feed_checkpoints`. It contains only
infrastructure state; tenant RLS is inapplicable. Runtime grants allow SELECT/INSERT
and updates of progress columns, without DELETE, identity updates or ownership.
Optimistic comparisons require increasing raw/canonical offsets and nondecreasing
source position/time. Source time remains old on duplicate or stale delivery.

Admission requires evidence for every expected partition. Age is the oldest source
commit time across those partitions, plus a conservative five-second clock-skew
allowance. Future source times are clamped to ingest time and counted in
`binding_feed_clock_skew_total`; structurally valid checkpoints are not quarantined
for clock skew. Clock synchronization remains an operational prerequisite. Failed reads,
missing partitions and invalid evidence deny admission. Receipt replay remains valid.
A source marker cannot make admission fresh before preceding records in its canonical
partition have committed. Crashes during fan-out may duplicate markers, which is safe.

## Consumer behavior and recovery

The Kafka group is `telemetry-binding-consumer`; the existing ADR-0005 inbox name
`device-binding` remains unchanged for replay compatibility. Domain messages pass the
repository JSON Schemas, identifier semantics, key/tenant/device checks and the
existing `ApplyInventoryEvent` transaction. Conflicting event IDs quarantine;
version gaps and missing prerequisites stop without offset advancement for repair.
Transient database failures get at most five attempts with one-second delays inside
a 20-second record deadline. Commit retries never repeat a committed effect in the
same processing attempt. Quarantine retains at most 64 KiB of original bytes.

Warn on `binding_feed_age_seconds > 60`; page above 240 seconds or for `+Inf`
with the default five-minute bound. See [R7 runbook and alerts](../WAL_RETENTION.md#r7-runbook-and-alerts). `binding_feed_stale_total` counts denied
new observations. Inspect connector state/WAL retention, transformer progress,
consumer readiness and checkpoints. Restore the failed component and let ordered
backlog drain. Resume admission only once fresh source checkpoints cover all six
partitions. Do not reset offsets, delete inboxes or clear checkpoints to manufacture
freshness. Topic recreation requires stopped admission and an explicit rebuild/reset.

## Verification boundary

Unit tests and kfake exercise consumption, quarantine, offset recovery and checkpoint
validation. They cannot prove the deployed connector's heartbeat action, transactional
WAL routing, database privileges or Docker crash recovery. `make events-e2e`, run
after `make events-test` against the live stack, supplies that evidence: source
checkpoints reach all six partitions on an idle feed, a stopped connector turns the gate
to `503 binding_feed_stale` within the configured bound, an identical retry is still
answered from its receipt while stale, and admission resumes once checkpoints return.
Debezium's own heartbeat record needs the provisioned
`__debezium-heartbeat.greenguard_inventory` topic (auto-creation is off). See
[evidence/STAGE_04B_VALIDATION.md](../../evidence/STAGE_04B_VALIDATION.md) for actual
commands, coverage and sandbox failures. No milestone is marked complete.
