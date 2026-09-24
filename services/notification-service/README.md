# services/notification-service

Status: **Stage 06d implemented locally** (RabbitMQ task consumer, provider adapter
interface, delivery ledger, tenant preferences). Real email/SMS/push/webhook providers and
templates are Stage 10.

Stages: 06, 10.

Technology: Node/TypeScript (plain Node, `pg` 8.23.0, `amqplib` 2.0.1). NestJS was not
needed: the service has no HTTP API beyond `/healthz` and `/metrics`.

## Delivery flow (`src/worker.ts`)

Manual-ack consumer on `notifications.tasks`, prefetch = `NOTIFICATIONS_MAX_IN_FLIGHT`.

1. Validate the task; `messageId` must equal `intent_id`. Poison → nack without requeue →
   `notifications.dlq`.
2. **Begin** (short locked tenant transaction, `ledger.ts`): insert the `deliveries` row once
   (`UNIQUE (intent_id)`), lock it `FOR UPDATE`, apply `notification_preferences`, record an
   `in_progress` attempt and commit **before** the provider call.
3. **Provider call** outside any transaction, through a separate bounded pool
   (`NOTIFICATIONS_PROVIDER_CONCURRENCY`) with a hard deadline
   (`NOTIFICATIONS_PROVIDER_TIMEOUT_MS`) that holds even if an adapter ignores its
   AbortSignal. The intent id is the adapter idempotency key.
4. **Finish** (locked tenant transaction): one guarded update. Terminal results are `sent`,
   `failed` (permanent rejection) and `suppressed` (preference). Each task carries a
   `delivery_generation` from the jobs-worker redrive count. A higher generation can retry
   an earlier `failed` or `suppressed` result; `sent` remains idempotent and is receipted
   without another provider call. Stale tasks and in-flight outcomes from older generations
   are acknowledged without writing a receipt or changing the current delivery.
5. **Follow-up with confirms, then ack**: terminal → receipt to `notifications.receipts`;
   transient → `notifications.retry` with exponential per-message expiration, until
   `NOTIFICATIONS_MAX_ATTEMPTS`, then `dead` + receipt + DLQ; a broker error after the commit
   requeues the task and the ledger makes the retry idempotent.

**Timeout is not failure.** A provider timeout (or a crash during the call, seen as a row
left `in_progress`) is recorded as `unknown`. The next delivery only **reconciles** through
the adapter (`reconcile(intent_id)`): delivered → `sent`; not delivered → resend under the
same idempotency key. After `NOTIFICATIONS_MAX_RECONCILES` it stays `unknown` and is parked
in the DLQ for an operator. It is never marked failed or retried without a limit.

## Adapters (`src/adapters.ts`)

`ProviderAdapter { send(request, signal); reconcile(key, signal) }`. `LocalTestAdapter`
records deliveries in memory and sends nothing (default, `NOTIFICATIONS_PROVIDER=local`).
`UnconfiguredAdapter` stands in for email/SMS/push until Stage 10 and reports a transient
error, so such tasks are retried and dead-lettered, never lost.

## Tables (`migrations/`, forward-only, applied by `make db-migrate`)

`notification_preferences` (optimistic `version`), `deliveries` (pessimistic row lock,
terminal guard trigger with a generation-reset exception), `delivery_attempts` (append-only,
generation-stamped). Forced RLS on every table,
composite tenant foreign key, `notifications_app` has no DELETE grant.

## Commands

```bash
npm test -w services/notification-service      # unit + live Postgres tests
make rabbitmq-test                             # includes src/testing/rabbit.live.ts
```
