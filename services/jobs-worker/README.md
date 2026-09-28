# services/jobs-worker

Status: **Stage 06d implemented locally** (durable notification intent ledger and RabbitMQ
dispatch). Canonical Kafka intake has an opt-in live test; run it with Kafka and jobs Postgres.

Stages: 06.

Technology: **Go** (franz-go v1.22.0, pgx v5, amqp091-go v1.15.0), RabbitMQ, PostgreSQL.

Responsibility: durable work dispatch, retries, DLQ, receipts.

## Language decision

The scaffold said Node/TypeScript + Express. 06d was built in Go instead because the owner
fixed the Kafka consumer on franz-go v1.22.0 and every other alert-path consumer
(`projection-builder`, `telemetry-ingest`, `cdc-transformer`) is a Go service with the same
`WithTenant`, golang-migrate and live-database test patterns. No HTTP API is needed here
(only `/healthz` and `/metrics`), so Express added nothing. The franz-go adapter
(`consumer_kafka.go`) sits behind the small `Source` interface and should adopt
`packages/kafka-transport` once that shared transport stops changing.

## Flow

1. **Intake** (`intake.go`, `store.go`): consumes committed alert lifecycle events
   (`greenguard.alerts.lifecycle.v1`, `contracts/events/alert-lifecycle.v1.schema.json`
   owned by workflow-alerts). The episode ID is the aggregate ID and is stored in the
   ledger's legacy `alert_id` and `episode_id` columns. In ONE tenant transaction it writes
   the `inbox` row, one `notification_intents` row per channel and one `dispatch_outbox` row.
   `intent_id` is a UUIDv5 of (tenant, alert episode, transition version, channel), so
   redelivery, replay or a second worker produce the same ID. Poison records are written to
   `quarantined_events` (coordinates, hash, reason; never the payload) before the offset
   commits. Offsets commit only after every record has an effect or a confirmed quarantine.
2. **Dispatch** (`dispatcher.go`): a scanner lists due outbox identifiers (read-only
   `jobs_due_dispatch_refs` SECURITY DEFINER selector, IDs only; migration 000005 removed the
   `app.scope` policies, and the redrive and DLQ scans use `jobs_dead_intent_refs` and
   `jobs_dead_letter_refs` the same way), then a bounded pool (`JOBS_DISPATCH_WORKERS`) locks each intent
   with `FOR UPDATE SKIP LOCKED`, publishes to RabbitMQ with a **publisher confirm** and
   marks it `dispatched` in the same transaction. A crash between the confirm and the commit
   leaves the row `pending`, so it is re-published with the **same message id**; the
   notification ledger deduplicates by intent id.
3. **Retry / dead**: a failed or unconfirmed publish backs off exponentially
   (1 s doubling, cap 5 min, no jitter) up to `JOBS_MAX_DISPATCH_ATTEMPTS` (8), then the row
   becomes `dead` in Postgres together with a `dead_letter_outbox` row in the same tenant
   transaction. The dispatcher repeatedly drains pending rows under a row lock, confirms a
   metadata-only copy to `notifications.dlq` (intent_id as
   message id, tenant_id, channel, attempts, last_error ≤ 200 chars, first/last attempt, dead_at;
   no body, address or contact data), then marks the outbox row published. If that publish
   fails it is logged and counted in `jobs_dlq_publish_failed_total`; the row remains pending
   for a later retry. A crash after broker confirm may republish the same logical record.
4. **Receipts** (`receipts.go`): notification-service reports `sent / failed / suppressed /
   dead` on `notifications.receipts` with the task's delivery generation (the intent's
   `redrive_count`). A guarded compare-and-set ignores receipts from prior generations and
   never moves a terminal intent,
   and the RabbitMQ delivery is acked only after the ledger commit.

## RabbitMQ profile

Durable **quorum** queues (supported on the single local node): `notifications.tasks`
(`x-delivery-limit` 5, at-least-once dead-lettering to `notifications.dlq`),
`notifications.retry` (no consumer; per-message expiration returns tasks after the backoff),
`notifications.dlq`, `notifications.receipts`. Declarations must match
`services/notification-service/src/topology.ts` exactly. Known limit: per-message TTL on a
queue expires only at the head, so a long backoff can delay a shorter one behind it.

## Operator commands

```bash
make dlq-replay ARGS="-limit 10"      # task records -> notifications.tasks, same message id;
                                      # dispatch-dead records -> audited redrive in Postgres
make redrive-dead ARGS="-reason 'broker restored' -limit 50 [-tenant UUID] [-actor NAME]"
```

`redrive-dead` is the only `dead -> pending` transition: in one tenant transaction it writes
`intent_redrives` (actor, reason, time, previous attempts/error/dead_at), resets the attempt
counter, keeps the same `intent_id` and re-arms the outbox. It works even when the DLQ copy
was never published. With `-tenant`, every read and write runs under that tenant's RLS;
without it, the read-only `redrive_scan` policy lists dead intents across tenants.

## Concurrency choices (ADR-0002)

| State | Choice |
| --- | --- |
| intent dispatch | pessimistic `FOR UPDATE SKIP LOCKED` per intent inside the tenant tx |
| receipts | guarded compare-and-set on `status` (monotonic) |
| redrive | `INSERT ... SELECT ... FOR UPDATE` on the dead row, then guarded update |
| inbox | primary key `(tenant_id, event_id)` |

## Configuration

`JOBS_DATABASE_URL`, `RABBITMQ_URL` (required); `KAFKA_BROKERS` (empty disables intake),
`ALERTS_LIFECYCLE_TOPIC`, `JOBS_KAFKA_GROUP`, `JOBS_HTTP_ADDR` (127.0.0.1:8095),
`JOBS_DISPATCH_WORKERS` (4), `JOBS_DISPATCH_BATCH` (50), `JOBS_RECEIPT_PREFETCH` (20),
`JOBS_MAX_DISPATCH_ATTEMPTS` (8). Critical opened/escalated/resolved transitions are always retained in the inbox but create no RabbitMQ intents; EventBridge/SQS/Lambda owns those notifications. Warning/non-critical email and SMS remain on RabbitMQ. The split is unconditional and has no runtime feature switch. Metrics carry no tenant labels.

The owner read API `GET /internal/v1/notification-intents?alertId=<uuid>&limit=50&after=<cursor>` pages warning intents (maximum 100). It verifies the RS256 signature, issuer, audience and expiry, then resolves `(issuer, subject)` through the GreenGuard membership source; tenant and operator/admin roles come from that source, never from a request parameter or IdP role claims. File mode reads `AUTH_MEMBERSHIP_FILE`; control-plane mode calls the bounded internal membership lookup using `CONTROL_PLANE_URL` and `CONTROL_LOOKUP_TOKEN`. The control-plane URL must use HTTPS. Local HTTP requires the explicit `AUTH_ALLOW_INSECURE_MEMBERSHIP_LOOKUP=true` opt-in. The DB query uses transaction-local forced RLS and an explicit tenant predicate. `JOBS_NOTIFICATION_CURSOR_KEY` must contain at least 32 random bytes. Missing auth, membership or cursor configuration leaves this read capability unavailable; `/readyz/notification-history` reports that separately from worker readiness. Critical delivery history is not exposed by this service.

## Commands

```bash
make jobs-migrate                     # forward-only migrations (also run by make db-migrate)
cd services/jobs-worker && go test -race ./...   # unit + live Postgres tests (via make verify)
make rabbitmq-test                    # live RabbitMQ tests; restarts the broker, purges queues
cd services/jobs-worker && JOBS_KAFKA_LIVE=1 KAFKA_BROKERS=127.0.0.1:59092 go test -count=1 -run TestKafkaAlertIntakeLive -v .
```

## Placement routing

With `SHARD_REGISTRY_FILE`, API tenants, validated alert events, receipts, dispatch, dead-letter publication, redrive and DLQ replay resolve current placement before tenant transactions. ID-only scans visit all four primaries sequentially with `JOBS_DISPATCH_BATCH` as a per-shard cap; dispatch concurrency retains its configured global worker bound. An operator redrive remains globally capped by `-limit`. Poison transport records have no authenticated tenant and use the explicit `s1` infrastructure quarantine ledger; it stores only source coordinates/hash/reason. A required unavailable shard fails the scan. See [Go sharding contract](../../packages/go-common/SHARDING.md).
