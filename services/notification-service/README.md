# services/notification-service

Status: **Stage 06d implemented locally** (RabbitMQ task consumer, provider adapter
interface, delivery ledger, tenant preferences). It serves `/healthz`, `/metrics`, and an
authenticated owner lookup for warning delivery outcomes; critical alerts are delivered by
the separate AWS Lambda path and never enter this service.
The warning/non-critical server worker resolves contacts through the authenticated tenant
control-plane API backed by PostgreSQL. No live provider credentials are required for local tests.
Stages: 06, 10.

Technology: Node/TypeScript (plain Node, `pg` 8.23.0, `amqplib` 2.0.1). NestJS was not
needed: the owner read API is small and uses the existing HTTP server.

## Owner read API

`POST /internal/v1/deliveries/lookup` accepts at most 100 unique `{intentId, deliveryGeneration}` pairs. It verifies the signed principal using `AUTH_ISSUER`, `AUTH_AUDIENCE`, and `AUTH_JWKS_URL`, permits only operator/admin, and derives tenant scope from that principal. Reads run in a transaction-local tenant context, with explicit tenant predicates and the existing forced-RLS policies. The response carries sanitized per-generation state and at most 20 newest attempt events. Provider references, raw errors, correlation IDs, trace IDs, destinations, and message content never leave the service. Access audit logs contain only a purpose-separated HMAC identifier; configure `NOTIFICATIONS_AUDIT_HMAC_KEY` with at least 32 random bytes. `/readyz/notification-history` checks the auth/audit configuration plus effective role, table grants, forced RLS and tenant policy expressions.

Critical Lambda/DynamoDB delivery history remains `not_configured`: no tenant-bound key builder and deployed IAM `LeadingKeys` denial proof are present. This owner does not read critical state or give the BFF DynamoDB access.

## Delivery flow (`src/worker.ts`)

Manual-ack consumer on `notifications.tasks`, prefetch = `NOTIFICATIONS_MAX_IN_FLIGHT`.

The critical serverless path is isolated from this worker. It reads the CDC-maintained
DynamoDB contact projection and delivers directly through SES/SNS; this service exposes no
critical dispatch endpoint and has no fallback responsibility.
1. Validate the task; `messageId` must equal `intent_id`. This worker accepts only
   exact `warning` severity; critical or unknown severity is rejected before flag
   lookup, database claims, or provider calls. Poison → nack without requeue →
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
`UnconfiguredAdapter` reports a transient error, so such tasks are retried and
dead-lettered. `NOTIFICATIONS_PROVIDER=live` selects SendGrid email and Twilio SMS
through `createProviderSelector`, resolving trusted contacts from the authenticated
HTTPS control-plane API. The live selector owns warning email/SMS only; push is
deferred. Runtime tests inject the resolver/fetch boundary and never call providers.

## Tables (`migrations/`, forward-only, applied by `make db-migrate`)

`notification_preferences` (optimistic `version`), `deliveries` (pessimistic row lock,
terminal guard trigger with a generation-reset exception), `delivery_attempts` (append-only,
generation-stamped). Forced RLS on every table,
composite tenant foreign key, `notifications_app` has no DELETE grant.

## Commands

```bash
npm test -w services/notification-service      # unit + live Postgres tests
make rabbitmq-test                             # includes src/testing/rabbit.live.ts
npm run live -w services/notification-service  # RabbitMQ + root Kafka/DynamoDB/CDC live suites
```
