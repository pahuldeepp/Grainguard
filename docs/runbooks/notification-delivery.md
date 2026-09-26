# Runbook: notification delivery failures or backlog

**Severity:** page for sustained critical notification failure or breached delivery objective; otherwise ticket.  
**Signals:** requested/attempted/accepted/confirmed/failed/ambiguous, provider latency, queue age, retries, DLQ.

## Triage

1. Separate critical serverless and warning/non-critical queue routes; confirm a notification has not entered both routes.
2. Check queue age/depth, attempts, provider throttles/timeouts, Lambda errors/throttles/cold starts, EventBridge target failures, and DLQ age.
3. Distinguish provider accepted from confirmed and user acknowledged. Ambiguous outcomes require reconciliation using the durable delivery ledger.
4. Restore the provider adapter or route according to policy. Do not blindly switch providers or resend ambiguous messages without idempotency/reconciliation.
5. Redrive only after the underlying failure is corrected and the approved redrive command selects the intended records.
6. Verify delivery outcomes progress, duplicate effects remain absent, backlog drains, and alert resolves.

## Recovery and evidence

Record route, provider, outcome counts, redrive range, and reconciliation results without exposing destination addresses or message payloads.
