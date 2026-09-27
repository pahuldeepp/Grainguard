import { test } from "node:test";
import assert from "node:assert/strict";
import { assertHistoryRange, HistoryEntitlementError } from "./history.js";
const day = 86_400_000;
test("ENT-06 history range follows the verified tenant and paid downgrade", async () => {
  const seen: string[] = [];
  const source = {
    rangeDays: async (tenantId: string) => {
      seen.push(tenantId);
      return { days: tenantId === "a" ? 30 : 7, planVersion: 2 };
    },
  };
  const to = new Date("2026-09-25T00:00:00Z");
  const from = new Date(to.getTime() - 10 * day);
  await assertHistoryRange(source, "a", from, to);
  await assert.rejects(
    assertHistoryRange(source, "b", from, to),
    HistoryEntitlementError,
  );
  assert.deepEqual(seen, ["a", "b"]);
});
