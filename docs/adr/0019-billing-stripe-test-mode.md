# ADR-0019: Stripe test-mode billing boundary

Status: accepted for Stage 09d engineering validation.

GreenGuard stores only Stripe identifiers, billing state mirrors, usage counts and encrypted webhook bodies. Checkout and Customer Portal host all payment method entry. Startup rejects keys without a `sk_test_` or `rk_test_` prefix; no live-mode money operation is in scope.

Every request to create a customer, Checkout Session, Portal Session or meter event first commits a tenant-scoped command and outbox event. The worker calls Stripe with a deterministic idempotency key. Repeating a command after a crash therefore repeats the same remote operation. Stripe webhooks are independently signature-verified and inserted into an encrypted inbox before HTTP acknowledgement. The worker re-fetches current remote objects, checks the customer-to-tenant directory and metadata, and writes the local mirror plus lifecycle outbox in one tenant transaction. Subscription versions use an explicit row lock and a monotonic Stripe timestamp/state hash guard. Usage close takes a `FOR UPDATE` lock on its period; late readings move into the next period with a late marker.

Billing events use `greenguard.billing.lifecycle.v1`, one strict v1 JSON schema per type. `entitlements.changed` is the source consumed by Stage 09c; consumers apply only increasing `source_version` per tenant. Reconciliation records differences and emits `billing.reconciliation_required`; it never adjusts invoice amounts automatically. Stripe account delivery, meter/invoice totals, currency and tax require owner-run test-mode checks before a production decision.
