# Stage 06d validation: durable notification delivery via RabbitMQ

Validated locally on 2026-09-24 (macOS ARM64). Real PostgreSQL 16 and a real RabbitMQ 4.2
node (`rabbitmq:4.2-alpine@sha256:b5c3420a…`, 256 MB limit, `infra/rabbitmq/compose.yaml`).
Kafka was stopped, so the franz-go alert intake is **unverified live** (unit/fake tested only).
No remote CI run yet. This file does not mark Stage 06 complete.

| Check | Result | Evidence |
| --- | --- | --- |
| Intent ledger | One tenant tx writes inbox + intents + dispatch outbox; redelivery is a no-op; a second event for the same transition creates no intent (UUIDv5 of tenant/episode/version/channel) | [jobs tests](stage-06d/jobs-worker-tests.log) |
| Tenant isolation | Two tenants: RLS hides and refuses cross-tenant rows; no-context reads see 0 rows; runtime roles cannot DELETE; dispatch/redrive scan policies are read-only | jobs + notification tests |
| Crash before commit | Rolled-back inbox/intent/delivery leaves nothing; retry succeeds once | tests |
| Concurrent dispatch | 4 dispatchers × 3 intents → exactly 3 publishes (`FOR UPDATE SKIP LOCKED`) | tests |
| Crash after confirm | Row stays pending, re-published with the SAME message id | tests |
| Broker restart mid-flight | 120 intents, broker restarted while dispatching: 0 missing, all `dispatched`, retries backed off | [rabbitmq-test](stage-06d/rabbitmq-test.log) |
| Delivery limit → DLQ, replay | Consumer crashing before ack → DLQ after 6 deliveries; `dlq-replay` keeps message id, `x-replayed=1` | rabbitmq-test |
| Dead dispatch → DLQ (best effort) | Metadata-only record (9 fields, last_error ≤200) with confirms; DLQ publish failure keeps `dead`, counts `jobs_dlq_publish_failed_total` | tests, rabbitmq-test |
| Redrive | Audited `intent_redrives` row (actor, reason, previous attempts); same intent_id; attempts reset; tenant filter isolated under RLS; later DLQ replay of the redriven intent is a no-op | tests, rabbitmq-test |
| One logical delivery | Redelivery, 5 concurrent duplicates, broker failure after commit, consumer crash before ack (live) → 1 provider send, 1 terminal result (trigger-guarded) | notification tests, rabbitmq-test |
| Timeout is not failure | Provider timeout → `unknown` → retry queue → reconcile → `sent` without a second send (live); endless hang stays `unknown` and is parked after max reconciles | tests, rabbitmq-test |
| Retry/DLQ | Transient failures back off 10/20 ms (test policy), `dead` + receipt + DLQ after max, replay then `sent` | tests, rabbitmq-test |
| Preferences | Suppression is a terminal result; optimistic version rejects stale writes | tests |
| Gates | `make verify` exit 0 | [verify](stage-06d/verify.log) |
| Coverage | jobs-worker 92.0% (main), rabbit 85.1%, cmd/migrate 100%; notification-service 94% lines | tests |

Bugs found and fixed: (1) `withTimeout` trusted the adapter to honour AbortSignal, so a hung
provider held a pool slot forever; it now races a hard deadline. (2) Reconcile to `sent`
updated `reconciles` after the terminal update and tripped the terminal guard; now one
UPDATE. (3) Live-test harness issues (waiting only for due rows; quorum queue briefly empty
after restart).

Not verified: live Kafka intake; contract `alert-*.v1` (local fixture); SonarQube/`make
coverage` (owned by another session); CI; real providers (Stage 10); per-message TTL
head-of-line delay on the retry queue.
