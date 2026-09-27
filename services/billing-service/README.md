# Billing service (Stage 09d)

Billing owns the local Stripe customer, subscription, invoice, dispute, usage and reconciliation mirrors in `greenguard_billing`. It never handles card data. Stripe is the authority for money; the local mirror supplies tenant-scoped entitlements and operational status. Only Stripe **test-mode** restricted or secret keys are accepted at startup.

## Transactions and concurrency

- Checkout, portal, customer creation and usage report requests are persisted as commands first. A worker calls Stripe using the command ID as the Stripe idempotency key, then records the result. A crash after the call therefore repeats the same operation safely.
- The raw, signature-verified webhook is AES-256-GCM encrypted and committed to `billing_inbox.stripe_webhook_inbox` before HTTP 2xx. The inbox has no RLS because its tenant is unknown until the event is verified and resolved; only the billing role can access it. Processing checks Stripe customer mapping and tenant metadata before touching tenant tables. Invalid cross-tenant events are quarantined.
- Customer and subscription mirrors use an explicit `version`. The subscription worker takes a row lock, re-fetches current Stripe state, then increments the version only when remote object version/updated timestamp is newer. Subscription and entitlement outbox rows commit with the mirror.
- `usage_periods` uses `SELECT ... FOR UPDATE` for both accepted-reading attribution and close. A reading racing a close is assigned to the next period and marked late after close. Event ID deduplication is in the same transaction as the hourly ledger increment.
- Every tenant table has application tenant predicates and forced PostgreSQL RLS. Runtime transactions set `app.tenant_id` locally, safe behind PgBouncer transaction pooling. The runtime role cannot delete audit, outbox or ledger rows.

## Local commands

```bash
npm run build -w @greenguard/billing-service
npm run test -w @greenguard/billing-service
npm run coverage -w @greenguard/billing-service
BILLING_MIGRATION_URL=postgresql://... npm run migrate -w @greenguard/billing-service
```

`BILLING_DATABASE_URL` is the PgBouncer/runtime role URL. `BILLING_MIGRATION_URL` is the direct migrator URL. `STRIPE_API_KEY` must start with `sk_test_` or `rk_test_`; `STRIPE_WEBHOOK_SECRETS` holds one or two comma-separated `whsec_` secrets for rotation. `BILLING_INBOX_ENCRYPTION_KEY` is a base64-encoded 32-byte key. A real account is never required for the local fake tests.

See `evidence/STAGE_09D_VALIDATION.md` for the exact test results and external Stripe account checks still needed.
