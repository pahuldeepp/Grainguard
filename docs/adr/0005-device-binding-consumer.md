# ADR-0005: device binding consumer, event sequence and Go connection rules

Status: accepted, 2026-09-24 (Stage 03a).

**Source of truth and transport.** Inventory owns devices. The telemetry service keeps a local `device_bindings` copy (plus a per-device `device_streams` row) built only from inventory events, so ingest never reads another service's database. Delivery from the inventory outbox to this consumer arrives with Debezium and Kafka in Stage 04; `ApplyInventoryEvent` is the consumer core and takes the event bytes from any transport.

**Applying an event** runs in one tenant transaction: inbox receipt, stream row, binding row.

- The inbox (`consumer_inbox`, keyed by consumer, tenant and event ID) makes redelivery a no-op. The same event ID with different content is `ErrEventConflict` and is never applied.
- `device.registered` creates the binding and stream if the device is unknown; if it is known the event is stale.
- Change events (`binding_changed`, `status_changed`) each carry only some columns, so they must arrive as the **next version** in the device's sequence. An older version is stale, a newer one is `ErrVersionGap`, and one for an unknown device is `ErrBindingMissing`. A plain "newest wins" rule would silently lose an update when version 3 overtakes version 2.
- Errors roll back the whole transaction, including the inbox receipt, so the transport can redeliver safely.
- Lock order is stream row, then binding row, the same as the ingest write path, to avoid deadlocks.

**Go and PgBouncer.** Runtime traffic uses PgBouncer transaction pooling, so pgx runs in `QueryExecModeExec` (no named prepared statements) and every tenant query goes through `WithTenant`. Migrations use the direct owner connection (`TELEMETRY_MIGRATION_URL`), because `golang-migrate` needs a session-level advisory lock. The migrator role owns the tables; `telemetry_app` cannot bypass RLS, cannot delete, and cannot rewrite identity columns.

**Not decided here.** Staleness of the binding feed (heartbeat checkpoints and fail-closed admission) is Stage 04. A separate role for the consumer versus the ingest path is deferred until they become separate processes.
