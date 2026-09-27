import assert from "node:assert/strict";
import { test } from "node:test";
import { syncCatalog, type CatalogPort } from "./sync.js";
import { plans, type PlanKey } from "./plans.js";

test("catalog sync uses stable lookup keys and rejects a mismatched price", async () => {
  const prices = new Map<string, { amount: number; currency: string }>();
  const saved: PlanKey[] = [];
  const port: CatalogPort = {
    async priceByLookupKey(key) { return prices.get(key) ?? null; },
    async createPrice(key, amount) { prices.set(key, { amount, currency: "usd" }); },
  };
  await syncCatalog(port, async (key) => { saved.push(key); });
  await syncCatalog(port, async () => {});
  assert.deepEqual(saved, ["free", "standard", "enterprise"]);
  assert.equal(prices.size, 2);
  prices.set(plans.standard.lookupKey, { amount: 1, currency: "usd" });
  await assert.rejects(syncCatalog(port, async () => {}), /different price/);
});

// Mirrors LimitKey in @greenguard/entitlements. A key missing from a plan silently
// falls back to the free default in every consumer, so paid plans must be complete.
const LIMIT_KEYS = ["devices.max", "seats.max", "api_keys.max", "ingest.readings_per_month",
  "ingest.rate_per_device", "ingest.rate_per_tenant", "retention.days", "history.range_days", "exports.per_day"];
test("every plan defines every limit key and paid plans never fall below free", () => {
  for (const [name, plan] of Object.entries(plans)) {
    const limits = plan.limits as Record<string, number>;
    for (const key of LIMIT_KEYS) assert.ok(Number.isFinite(limits[key]), `${name} is missing ${key}`);
    for (const key of LIMIT_KEYS) assert.ok(limits[key] >= (plans.free.limits as Record<string, number>)[key], `${name} ${key} below free`);
  }
  assert.ok((plans.standard.limits as Record<string, number>)["exports.per_day"] > 0);
});
