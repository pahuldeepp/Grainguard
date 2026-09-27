# Stage 09d billing validation — 2026-09-25

## Implemented

The billing service has five PostgreSQL migrations, forced RLS on tenant tables, a test-mode-only Stripe adapter, durable commands, encrypted signature-verified webhook inbox, customer/tenant mapping, subscription and entitlement outbox, usage aggregation and close, reconciliation findings, and an audited exact-event redrive command. A due-work index bounds scheduled transition scans, and malformed Kafka source offsets are recorded in a restricted inbox table before they are skipped. Five billing event schemas are registered in `@greenguard/contracts`. Stripe-hosted Checkout and Customer Portal are the only payment entry points; the service does not accept card data.

## Executed checks

| Command/check | Result |
|---|---|
| `npm run test -w @greenguard/billing-service` with ignored `.env` loaded (`BILLING_DATABASE_URL`, `POSTGRES_ADMIN_URL`), local PostgreSQL, fake Stripe port | **21 passed, 0 failed, 0 skipped**. Includes B01–B16 scenarios, catalog lookup-key sync, tenant RLS, authenticated HTTP 401/403/202, command persistence before 202, and HTTP bad-signature no-store check. Official Stripe SDK signs and verifies webhook test payloads. |
| `npm run test -w @greenguard/contracts` | **23 passed, 0 failed**, including all five billing lifecycle schemas and a mismatched entitlement tenant rejection. |
| `npm run build -w @greenguard/billing-service` | Passed Prisma generation and TypeScript compilation. |

## Runtime queue confidentiality follow-up (2026-09-25)

The two global work indexes now expose only their identifier columns. Migration `20260925200000_billing_queue_id_selectors` adds `claim_command_work()` and `ready_due_tenants()` selectors that return IDs; migration `20260925210000_billing_queue_write_procedures` moves queue writes behind tenant-context-checked functions and revokes direct runtime `INSERT`/`UPDATE`. `billing_app` cannot select queue status, attempts, due dates, leases or retry timing.

Verified with the local PostgreSQL role: `npm test -w @greenguard/billing-service` passed **36/36** with zero skips. The live privilege test checks visible columns, denied `SELECT *`, function execution, and the worker's restart/due-work flows. `git diff --check` passes. No cloud billing credentials are involved.

The fake Stripe port records customers, Checkout Sessions and meter submissions so retries can be asserted without an account. B06 injects failure after remote Checkout creation and proves one remote session. B03/B05 prove inbox duplicates and restart replay leave one subscription/entitlement effect. B10/B11 prove meter resend and close concurrency do not double count. B13 proves a forged tenant metadata value quarantines the webhook and changes neither tenant. B16 verifies replay audit and applied-event no-op. The HTTP test sends the exact raw bytes through Nest and confirms a bad signature returns 400 with zero inbox rows.

The local test database contained old pending webhook rows during one run. The B03 test was corrected to claim its own event ID; rerun passed all 21 tests. This isolates the test fixture without changing production worker behavior.

CodeRabbit reviewed `services/billing-service` and returned ten findings. The identified checkout guard, canceled-subscription replacement, downgrade boundary, transient webhook retry, consumer batching and malformed-record handling, bounded due-work scheduling, graceful shutdown, URL error mapping, and generated artifact issues were addressed. A focused regression check for canceled-subscription replacement was added after that review and awaits the next live database run.

## External checks still required

No real Stripe credentials were used. An owner must complete a test-mode Checkout with a Stripe test card, verify actual Stripe webhook delivery/retry timing and dashboard resend, inspect meter event acceptance and invoice preview, test Portal cancellation, and approve price, currency and tax settings. The catalog amounts are engineering fixtures and require owner approval before syncing to a Stripe account. These are account-dependent checks, not local test failures. Live-mode keys are rejected at startup.

The Kafka connector and Stage 09c entitlement adapter are integrated by the Stage 09 coordinator; this evidence establishes the billing producer and its strict schemas, while a full cross-service Kafka entitlement propagation test must be recorded separately once those pieces are joined.

## Review fixes F4 (2026-09-25), test-first

Red first: 11 new tests failed against stubbed behaviour (close at period end, period-start meter timestamp, silent quarantine, counted waits, concurrent Checkout, duplicate subscription quarantine, `paused` unsupported, no webhook redrive, DELETE grant), then went green. After the fixes: `npm run test -w @greenguard/billing-service` **35 passed, 0 failed, 0 skipped** (twice); `@greenguard/contracts` 23 passed; billing lint and `npm run typecheck` clean.

| Finding | Fix |
|---|---|
| Meter timestamp | Stripe docs: an event time must be within the past 35 calendar days or up to 5 minutes ahead. The event time is now the last second of the usage month clamped into a 34-day window, fixed in the command payload at close so a retry repeats the same request. Quarantine raises `billing.reconciliation_required` (`command_quarantined`) and `BillingCommands.redriveCommand` re-queues it with the same idempotency key. |
| Close lag | Usage periods close only `BILLING_CLOSE_LAG_MS` (default 15 min) after the period end and only while the Kafka consumer lag (`ConsumerLag`) is under 60 s. Attribution stays by the reading's `received_at`. B11 now asserts per-period totals against the report quantity and the `late` flag. |
| Webhook stall | `redriveQuarantined` (worker sweep): transient quarantines return to pending after 15 min doubling to 6 h, at most 6 times, 20 per sweep, audited as `system:auto-redrive`; `TenantMismatch` and `InvalidWebhook` never. `paused` is stored and keeps the existing entitlement (free if none); `incomplete_expired` maps to `canceled` (no entitlement). |
| Concurrent Checkout | Per-tenant advisory lock plus a check for an open Checkout command. A second completed subscription is cancelled through the port (prorated credit, no automatic refund), a `duplicate_subscription` finding is raised and the event is applied. |
| Waits | A command waiting for its customer is not an attempt; the queue row backs off through `command_work.available_at` (2^n s up to 5 min). |
| Work queues | Follow-up migrations `20260925200000` and `20260925210000`: queue tables have no RLS because workers discover work across tenants, but `billing_app` can read only ID columns, cannot directly insert/update/delete, and uses bounded selector/write functions. |

Unverified: the meter window and status semantics were read from the current Stripe docs, not exercised against a Stripe account; the duplicate-cancel proration and the `paused` policy need an owner test-mode check. A consumer that stops delivering batches entirely is not seen by the lag bound.
