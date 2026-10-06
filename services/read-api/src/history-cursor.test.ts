import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeHistoryCursor, encodeHistoryCursor } from "./history-cursor.js";

const context = {
  tenantId: "11111111-1111-4111-8111-111111111111",
  deviceId: "33333333-3333-4333-8333-333333333333",
  from: new Date("2026-09-01T00:00:00Z"),
  to: new Date("2026-10-01T00:00:00Z"),
  limit: 100,
  hotStart: new Date("2026-09-30T00:00:00Z"),
  placement: {
    shardId: "s1",
    shardIncarnation: "22222222-2222-4222-8222-222222222222",
    placementEpoch: "5",
  },
};
const after = {
  observedAt: new Date("2026-09-18T12:00:00Z"),
  readingId: "44444444-4444-4444-8444-444444444444",
};
const secret = "read-api-cursor-secret-fixture-value";

test("history cursor is signed and bound to tenant, device, range, page size, and placement", () => {
  const token = encodeHistoryCursor(context, after, secret, 1000);
  const decoded = decodeHistoryCursor(token, context, secret, 2000);
  assert.deepEqual(decoded.after, after);
  assert.equal(decoded.hotStart.toISOString(), context.hotStart.toISOString());
  assert.throws(
    () =>
      decodeHistoryCursor(
        token,
        { ...context, tenantId: "55555555-5555-4555-8555-555555555555" },
        secret,
        2000,
      ),
    /invalid_cursor/,
  );
  assert.throws(
    () => decodeHistoryCursor(token, { ...context, limit: 50 }, secret, 2000),
    /invalid_cursor/,
  );
  assert.throws(
    () => decodeHistoryCursor(token, context, "different-secret", 2000),
    /invalid_cursor/,
  );
});

test("history cursor rejects tampering and expiry", () => {
  const token = encodeHistoryCursor(context, after, secret, 1000);
  const [payload, signature] = token.split(".");
  const changed = `${payload!.slice(0, -1)}${payload!.endsWith("A") ? "B" : "A"}.${signature}`;
  assert.throws(
    () => decodeHistoryCursor(changed, context, secret, 2000),
    /invalid_cursor/,
  );
  assert.throws(
    () => decodeHistoryCursor(token, context, secret, 15 * 60_000 + 1001),
    /invalid_cursor/,
  );
});

test("cursor configuration requires a dedicated secret without credential fallbacks", async () => {
  const { requireHistoryCursorSecret } = await import("./history-cursor.js");
  assert.throws(
    () => requireHistoryCursorSecret(undefined),
    /READ_HISTORY_CURSOR_SECRET/,
  );
  assert.throws(
    () => requireHistoryCursorSecret("short"),
    /READ_HISTORY_CURSOR_SECRET/,
  );
  assert.equal(requireHistoryCursorSecret(secret), secret);
});
