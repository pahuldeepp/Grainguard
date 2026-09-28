import assert from "node:assert/strict";
import { test } from "node:test";
import { validateEvent } from "./index.js";

const tenant = "11111111-1111-4111-8111-111111111111";
const aggregate = "22222222-2222-4222-8222-222222222222";
const envelope = (
  eventType: string,
  aggregateType: string,
  payload: Record<string, unknown>,
) => ({
  event_id: "33333333-3333-4333-8333-333333333333",
  event_type: eventType,
  schema_version: 1,
  occurred_at: "2026-09-25T18:00:00.000Z",
  tenant_id: tenant,
  aggregate_type: aggregateType,
  aggregate_id: aggregate,
  aggregate_version: "1",
  correlation_id: "44444444-4444-4444-8444-444444444444",
  causation_id: "55555555-5555-4555-8555-555555555555",
  traceparent: "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01",
  payload,
});

test("billing lifecycle contracts validate all five outbox event shapes", () => {
  const events = [
    envelope("subscription.changed", "subscription", {
      subscription_id: "sub_test",
      status: "active",
      plan_key: "standard",
      current_period_start: "2026-09-01T00:00:00.000Z",
      current_period_end: "2026-10-01T00:00:00.000Z",
      cancel_at_period_end: false,
      version: "1",
    }),
    {
      ...envelope("entitlements.changed", "entitlement", {
        tenant_id: tenant,
        plan_key: "standard",
        plan_version: "1",
        limits: { "devices.max": 100 },
        features: { sso: false },
        source_version: "1",
        effective_at: "2026-09-25T18:00:00.000Z",
      }),
      aggregate_id: tenant,
    },
    envelope("usage.accepted", "usage_period", {
      tenant_id: tenant,
      meter: "accepted_readings",
      period_start: "2026-09-01T00:00:00.000Z",
      quantity: "2",
      total: "2",
      version: "1",
      late: false,
    }),
    envelope("billing.reconciliation_required", "reconciliation_finding", {
      tenant_id: tenant,
      finding_id: aggregate,
      object_type: "invoice",
      object_id: "in_test",
      diff_class: "invoice_mismatch",
    }),
    envelope("billing.command_requested", "billing_command", {
      command_id: aggregate,
      kind: "checkout",
    }),
  ];
  for (const event of events) {
    const result = validateEvent(event);
    assert.deepEqual(result.ok ? [] : result.errors, [], event.event_type);
  }
  const mismatched = structuredClone(events[1]!);
  mismatched.payload.tenant_id = "66666666-6666-4666-8666-666666666666";
  assert.equal(validateEvent(mismatched).ok, false);
});
