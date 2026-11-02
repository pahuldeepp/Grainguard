# ADR-0031: Flink anomalies as an advisory input to the risk engine

Status: PROPOSED for owner review, 2026-11-01. Implemented locally behind `RISK_FLINK_ANOMALIES` (default `off`). Supersedes the sentence "No existing service consumes the derived topics" in [ADR-0030](0030-flink-optional-stream-processing.md). Stage 06 status is unchanged: this is a user-directed optional extension, not a stage completion.

## Context

Flink publishes `greenguard.telemetry.anomaly.v1` (advisory `zscore` and `rapid_change` signals). Nothing reads it. The risk engine scores threshold breaches only. The alert chain (`risk.assessed` → workflow-alerts → lifecycle → jobs-worker → notification) already works and must keep working unchanged.

Facts that constrain the design (verified in code):

1. `workflow-alerts` `decide()` **resolves** an open episode for any assessment with score below `clearScore` (25), and **updates** severity to the assessment's severity otherwise. An advisory assessment that is lower than the current one would therefore downgrade or silence a real alert.
2. `risk.assessed` requires `reading_id`, `assessment_version` and a closed `reasons` enum; assessments are keyed `(tenant, source_event_id, lot_id, policy_version)` and `causation_id = source_event_id`.
3. The risk engine is the only writer of `risk.assessed` and publishes through its transactional outbox.
4. Flink delivers at least once, roughly one watermark bound (default 2 min) after the reading.

## Decision

The risk engine adds a second input, `greenguard.telemetry.anomaly.v1`, and remains the **only authority** for official alerts. An anomaly can only **add** risk; it can never lower, replace or suppress what the threshold path decides.

### Policy (all values configurable, validated at startup)

For one validated anomaly on an active, bound device with a known lot:

First wait for a durable `telemetry.recorded` inbox receipt matching the anomaly's tenant, `causation_id`, device and `reading_id`. Source receipt and threshold outcome commit atomically. Kafka orders neither the source and derived topics nor different devices; an anomaly can otherwise permanently lose corroboration, use a stale zero/warning, or open a warning before its critical trigger is assessed. Missing trigger context returns NOT READY, rolls back the anomaly receipt/decision and pauses only that anomaly partition. The existing bounded wait ends in `threshold_state_unavailable` quarantine. A source processed under another Kafka group satisfies the same receipt check. Migration 000009 indexes this lookup.

1. `base` = score of the device's **latest threshold-sourced assessment for the same lot** observed within `RISK_ANOMALY_CORROBORATION_WINDOW_S` (default 3600 s) before the anomaly, or any time after it (the newest state wins, so a delayed anomaly cannot resurrect a condition that has already cleared). No such assessment means no corroboration.
2. `points` = `RISK_ANOMALY_ZSCORE_POINTS` or `RISK_ANOMALY_RAPID_POINTS` (default 25 each; the existing threshold policy awards 25 for a warning-level reading and 50 for a critical one).
3. `combined = max(base, min(RISK_ANOMALY_CAP, base + points))`, cap default 74, so an anomaly alone can **never** reach the critical band (75+); critical stays threshold-driven.
4. **Publish only if `combined > max(base, published)` and `combined >= policy.alert_score`**. Corroboration uses sensor observation time, but the publication guard uses each active, currently bound device's latest non-invalidated assessment **by stream version**, for the same tenant, bin and event-time lot, then takes the maximum score. It has no observation-age cutoff: an old observation can still be the latest published critical assessment. Device stream versions are not comparable across devices. Retired bindings and previous lots do not suppress future advisory episodes after the bin clears. The downstream locked advisory guard also protects a still-open critical episode against cross-device reordering. Anything else is recorded, not published.
5. Anomalies older than `RISK_ANOMALY_MAX_AGE_S` (default 3600 s, measured against the risk engine's clock) are recorded as `too_old` and never published, so a replay after an outage or a seven-day-late reading cannot open an alert for a condition that is long over.
6. The event-time lot remains the audit association. If the known occupancy covering the risk engine's current clock differs from the selected event-time occupancy, record `superseded_lot` without publishing. A delayed advisory must not open a fresh episode for grain already replaced in the bin. A scheduled future placement does not supersede the present occupancy early. Threshold event-time scoring is unchanged.

Worked example with the synthetic wheat policy: latest reading 27 C (25 points, score 25, not alert-eligible) plus a `rapid_change` anomaly (25 points) gives 50, a warning, which opens an alert. A lone anomaly on a normal reading (base 0) gives 25 and is recorded only.

### Idempotency and ordering

- Inbox row per anomaly `event_id`, using the stable `risk-engine.anomaly.v1` consumer identity independently of Kafka group names; an additional insert-only `anomaly_decisions` row records the outcome (published or the reason it was not) for audit. Skipped decisions are final too. Migration 000006 backfills the stable receipts for earlier published and skipped decisions and restores forced RLS before commit.
- Assessment IDs use the existing `deterministic_ids(tenant, source_event_id, lot_id, policy_version)` with `source_event_id` = the anomaly's `event_id`, so a replay reproduces the same assessment and outbox event.
- Concurrency uses the existing locks: device binding row `FOR UPDATE` and the per-bin advisory lock, then `next_stream_version`. A threshold reading and an anomaly for the same device serialise and get increasing `assessment_version`s.
- Duplicate or contradictory notifications are prevented by the four layers above: inbox, unique assessment key, `combined > base`, and workflow-alerts' unique episode key with idempotent lifecycle events. Notifications are sent only on `alert.opened/escalated/resolved`, never on `updated`.
- Kafka has no ordering guarantee across devices. The alert consumer therefore also recognizes advisory reason codes and ignores an advisory that would lower severity or fail to increase the active episode's score. An ignored advisory does not replace the episode's causal assessment, so invalidating it cannot resolve a threshold-driven critical episode. Threshold-driven lifecycle behavior is preserved.

### Validation and tenant isolation

Strict envelope and payload parsing (no unknown fields); `aggregate_id == payload.device_id`; the Kafka key must equal `tenant_id:aggregate_id`; metric and detector from fixed sets; finite numbers; `advisory` must be `true`. The device must have a local binding, status `active` and the same `bin_id` as the event; the lot comes from the existing event-time lot join with the same lot-feed watermark gate. An unbound device, a disabled device or a bin mismatch is recorded and skipped. A missing binding or lot is NOT READY (retry, per-partition pause, existing bounded wait). All queries filter by tenant under forced RLS.

### Contract changes (additive)

- `contracts/events/risk-assessed.v1.schema.json`: two new `reasons` values, `anomalous_temperature` and `anomalous_humidity`. Consumers with a validator must be upgraded **before** the flag is enabled (rollout order below).
- `contracts/stream/telemetry-anomaly.v1.schema.json`: new required `reading_id` (the risk assessment needs it). The contract was never consumed and is unreleased, so it stays v1.

### Flag, failure behaviour and rollback

- `RISK_FLINK_ANOMALIES=off` (default): the risk engine does not subscribe to the anomaly topic and its code path is not entered. Behaviour is byte-for-byte the existing behaviour.
- `on`: Flink being down, delayed or restarting only means fewer anomaly records; the threshold path is untouched, so a critical threshold alert is never delayed or lost because of Flink. An anomaly record waiting for context pauses only its own partition.
- Rollback: set the flag to `off` and restart. Assessments already published are normal `risk.assessed` events and follow the normal lifecycle (they resolve when readings improve). `anomaly_decisions` rows stay as audit.
- Rollout order: (1) deploy workflow-alerts with the advisory guard, plus projection/search consumers and the CDC transformer with the new schema; (2) apply migrations 000005 through 000009 before deploying the new risk-engine binary; (3) deploy risk with the flag off, then create the topic and run Flink; (4) enable the flag per environment only after verification.

## Consequences and risks

- Anomaly-driven alerts arrive about one watermark bound after the reading by design (ADR-0030).
- The default points and cap are synthetic and uncalibrated, like the threshold policy; calibrate before real alerts.
- Changing the points configuration does not re-evaluate decisions already made (inbox dedupe); a policy change needs a new policy version.
- Only `risk.assessed` reason codes grew. Dashboards that render reasons need copy for the two new codes.
- The bin-wide guard is deliberately conservative for currently active contributors: their last critical publication for the relevant lot can suppress advisory escalation until superseded or invalidated. Inactive or moved devices and previous lots are excluded. It does not block threshold assessments or change existing alert resolution rules. Migration 000007 adds binding/lot indexes so the guard uses one latest-publication index lookup per active bound device rather than scanning history. End-to-end ordering and outage acceptance remain separate from database regression evidence.
- Migrations 000006 and 000007 build their publication indexes transactionally; 000006 also takes table locks while backfilling receipts and restoring forced RLS. On a populated deployment, schedule a maintenance window and measure migration duration on representative data before rollout. Do not edit an applied migration or bypass the checksum ledger to add `CONCURRENTLY`; that requires a separate, reviewed deployment procedure. None of the local correctness tests proves production migration downtime.
