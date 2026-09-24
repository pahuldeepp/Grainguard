# services/risk-engine

Status: **Stage 06a core built locally** (see [06a1 evidence](../../evidence/STAGE_06A1_VALIDATION.md)). The database, event-time join, transactional apply and consumer loop are implemented and tested against a fake source and live PostgreSQL. The live Kafka path, CDC publication of the risk outbox and transformer routing of `risk.assessed` are **not** built or verified yet. Stage 06 remains open.

Technology: Python 3.14, psycopg 3, confluent-kafka (pinned in `requirements*.txt`). Responsibility: versioned agricultural scoring and reliable result publication. Owner of database `greenguard_risk`.

## Flow

Topics consumed: `greenguard.inventory.device.v1` (bindings and ADR-0009 checkpoints), `greenguard.inventory.lot.v1` (`lot.changed`), `greenguard.telemetry.recorded.v1`.

Each record is parsed strictly (`risk_engine/events.py`), then applied in **one tenant transaction** (`risk_engine/apply.py`): inbox receipt, then either a local-state change (device binding or lot interval) or, for telemetry, the event-time join (`risk_engine/join.py`), scoring (`risk_engine/scoring.py`), a `risk_assessments` row and a `risk.assessed` outbox row. The Kafka offset is committed only after that commit or after a confirmed quarantine (`risk_engine/consumer.py`).

| Outcome | Offset | Effect |
| --- | --- | --- |
| applied / stale / skipped (`device_unbound`) | committed | receipt (+ state or assessment + outbox) |
| duplicate (same event ID and payload digest) | committed | nothing new; the original assessment and event IDs are kept |
| not ready (`binding_state_unavailable`, `lot_state_unavailable`, `lot_feed_stale`, `lot_predecessor_missing`) | **not** committed; the partition is paused and retried with backoff | nothing (rolled back). After `RISK_NOT_READY_MAX_WAIT_S` (default 300 s) the record is quarantined as `lot_state_unavailable` / `binding_state_unavailable` |
| quarantine (`invalid_event`, `unsupported_event`, `event_id_conflict`, `invalid_measurements`, `policy_unavailable`, `binding_conflict`, `lot_version_conflict`, `lot_predecessor_mismatch`, `db_rejected`) | committed after the quarantine row commits | nothing (rolled back) |
| transient DB error (SQLSTATE 08, 40001, 40P01, 53, 55P03, 57014, 57P0x) | not committed | retried 5 times with backoff, then the process stops |
| RLS/permission (42501) or any other DB error | not committed | the process stops; never quarantined |

## Event-time lot selection

The lot is the interval covering the reading's `observed_at`, half-open `[effective_from, effective_to)` as in device-service. A reading at 11:00 in a bin switched from wheat to canola at 12:00 is scored as wheat, even if it arrives after the switch. A binding older than the reading's `binding_version`, no covering interval, or an **open** interval whose freshness is unproven is not ready, never scored with a guessed crop.

Freshness of an open interval: an ADR-0009 checkpoint read from the device topic proves the transformer had already published every earlier lot change. The consumer snapshots the lot topic's high watermarks then; once its own applied offsets reach them, lot state is complete up to the checkpoint's source time (`LotFeed`). `RISK_LOT_FEED_GATE=off` disables this gate (development only).

Backdated placement retracts affected earlier assessments through `risk.assessment_invalidated` events and an append-only invalidation ledger. Downstream alert retraction and corrective rescoring still need integration. There is no lot retirement/empty-bin event yet, so an open interval stays open until the next placement.

## Database (`migrations/`)

Forward-only migrations applied by `python -m risk_engine.migrate` (`make risk-migrate`, included in `make db-migrate`) as `risk_migrator`, the owner. It uses a checksum ledger, rejects edited or duplicate versions and runs under an advisory lock. Runtime role `risk_app` has `NOBYPASSRLS` and no DELETE. It sets `app.tenant_id` with `set_config(..., true)` in each transaction (PgBouncer transaction pooling, no prepared statements). Backdated lot replacement records each affected prior assessment in an append-only invalidation ledger and emits `risk.assessment_invalidated` through the same transaction's outbox; scoring and lot replacement serialize on a per-bin advisory lock so no old-lot assessment can commit after the invalidation scan.

| Table | Tenant/RLS | Runtime writes | Concurrency choice |
| --- | --- | --- | --- |
| `consumer_inbox` | forced | INSERT | PK + `ON CONFLICT DO NOTHING`, then digest compare |
| `device_bindings` | forced | INSERT, UPDATE of state/version columns | `FOR UPDATE` + monotone version trigger |
| `bin_lot_intervals` | forced, GiST no-overlap | INSERT, UPDATE of `effective_to` only (NULL → value, once; trigger) | per-bin `pg_advisory_xact_lock`; increasing `occupancy_version` trigger |
| `device_risk_streams` | forced, FK to bindings | upsert `last_version` | row lock of `ON CONFLICT DO UPDATE` |
| `risk_assessments` | forced, composite tenant FKs | INSERT only | unique `(tenant, source_event_id, lot_id, policy_version)` |
| `risk_assessment_invalidations` | forced, composite `(tenant_id, assessment_id)` FK | INSERT only | one retraction per assessment |
| `outbox_events` | forced; CDC snapshot policy for `cdc_reader`; publication `greenguard_outbox` | INSERT only | unique aggregate version |
| `quarantine_samples` | not tenant data (no tenant/payload, only Kafka coordinates, reason, digest) | INSERT/UPDATE, slot = offset % 1000 | overwrite-only, bounded |

Deterministic identity: `event_id` and `assessment_id` are UUIDv5 of `(tenant, source_event_id, lot_id, policy_version)`, so retries and replays (even under a new consumer name) never mint a different ID or a second outbox row.

## Run

```bash
make risk-migrate      # forward-only migrations
make risk-test         # unit tests + live DB tests (live tests skip without RISK_* env)
KAFKA_BROKERS=127.0.0.1:59092 RISK_KAFKA_OFFSET_RESET=earliest \
  .local/risk-venv/bin/python -m risk_engine.main   # from services/risk-engine; UNVERIFIED live
```

`RISK_KAFKA_OFFSET_RESET` defaults to `error`: a lost or expired committed offset stops the process instead of skipping. Only a brand-new group is started once with `earliest`. Health: `:8086/healthz`, `/readyz` (a separate database probe is reachable and the consumer loop has completed a step within 10 seconds), `/metrics` (labels: topic, outcome, reason; never tenant or device). The scoring policy is synthetic and must be calibrated before real alerts. See [Stage 06 plan](../../docs/STAGE_06_PLAN.md).
