import assert from "node:assert/strict";
import { test } from "node:test";
import { mapSubscriptionStatus } from "./stripe-port.js";
import { meterEventTime, monthStart, nextMonth } from "./usage.js";

const DAY = 86_400_000;

test("F4 meter event time stays inside Stripe's accepted window and the usage month", () => {
  const start = monthStart(new Date(Date.UTC(2026, 8, 15)));
  const closedAt = new Date(nextMonth(start).getTime() + 20 * 60_000);
  const eventTime = meterEventTime(start, closedAt);
  assert.ok(eventTime >= start && eventTime < nextMonth(start));
  assert.ok(eventTime.getTime() >= closedAt.getTime() - 35 * DAY);
  assert.ok(eventTime.getTime() <= closedAt.getTime() + 5 * 60_000);
});

test("F4 an old period is clamped into the accepted 35 day window", () => {
  const start = monthStart(new Date(Date.UTC(2025, 0, 15)));
  const now = new Date(Date.UTC(2026, 8, 25));
  const eventTime = meterEventTime(start, now);
  assert.ok(eventTime.getTime() >= now.getTime() - 35 * DAY);
  assert.ok(eventTime.getTime() <= now.getTime());
});

test("F4 paused keeps a defined status and incomplete_expired carries no entitlement", () => {
  assert.equal(mapSubscriptionStatus("paused"), "paused");
  assert.equal(mapSubscriptionStatus("incomplete_expired"), "canceled");
  assert.equal(mapSubscriptionStatus("active"), "active");
  assert.throws(() => mapSubscriptionStatus("mystery"), /unsupported Stripe subscription status/);
});
