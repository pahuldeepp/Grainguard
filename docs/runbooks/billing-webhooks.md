# Billing webhook operations (Stripe test mode)

The receiver at `POST /webhooks/stripe` verifies the signature against one or two active signing secrets and stores the exact body encrypted in `billing_inbox.stripe_webhook_inbox`. A 2xx means the inbox insert committed, not that the subscription changed. The worker resolves the Stripe customer to one tenant, checks metadata, then commits the mirror and outbox together. Duplicate event IDs return 2xx without another effect.

Inspect backlog with the billing migrator or an operator account:

```sql
SELECT status, event_type, count(*) FROM billing_inbox.stripe_webhook_inbox
GROUP BY status, event_type ORDER BY status, event_type;
SELECT event_id, event_type, attempts, last_error, received_at
FROM billing_inbox.stripe_webhook_inbox
WHERE status IN ('pending', 'quarantined') ORDER BY received_at LIMIT 100;
```

`last_error` contains an error class only. Never print encrypted payloads, signing headers, API keys, or full customer objects. A `TenantMismatch` means the customer directory, Stripe customer metadata, or event metadata disagree; check the mapping before replay. Transient errors use exponential retry backoff and move to `quarantined` after ten attempts.

After correcting the cause, replay one exact event with an auditable actor and reason:

```bash
npm run redrive -w @greenguard/billing-service -- evt_example operator-id 'mapping repaired' tenant-uuid
```

The optional tenant UUID makes the command fail if the stored event belongs to another tenant. An already applied event remains a no-op; each replay attempt is recorded in `billing_inbox.webhook_redrive_audit`. The worker picks up a queued row on its next cycle. Check its final `status` and the tenant's `subscriptions` version and `outbox_events` before closing the incident. Do not use replay to change an invoice amount: Stripe is the authority for money. Run reconciliation when a mirror differs.

Secret rotation: set `STRIPE_WEBHOOK_SECRETS` to `new,old` during the overlap, confirm signed deliveries with the new secret, then remove the old secret. `BILLING_INBOX_ENCRYPTION_KEY` must remain available for every stored inbox row until those rows are retired by the retention procedure; rotating it requires a data re-encryption migration.
