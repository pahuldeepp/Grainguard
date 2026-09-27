import assert from "node:assert/strict";
import test from "node:test";
import { DynamoFlagSnapshotStore } from "./dynamodb.js";
import type { FlagChange } from "./index.js";

const tenantId = "11111111-1111-4111-8111-111111111111";
const valid: FlagChange = {
  scope: "tenant",
  tenantId,
  version: 1,
  flags: { enabled: { value: true } },
};

test("DynamoDB snapshot validation rejects malformed input before sending", async () => {
  let sends = 0;
  const client = {
    async send() {
      sends++;
      throw new Error("invalid snapshots must not reach DynamoDB");
    },
    destroy() {},
  };
  const store = new DynamoFlagSnapshotStore(client as never, "flags");
  const invalidChanges: [string, unknown, RegExp][] = [
    ["null change", null, /scope/],
    ["unknown scope", { ...valid, scope: "organization" }, /scope/],
    ["invalid tenant", { ...valid, tenantId: "not-a-uuid" }, /tenant ID/],
    [
      "infrastructure tenant",
      { ...valid, tenantId: "00000000-0000-4000-8000-000000000001" },
      /reserved/,
    ],
    ["tenant on global snapshot", { ...valid, scope: "global" }, /global/],
    [
      "unsafe version",
      { ...valid, version: Number.MAX_SAFE_INTEGER + 1 },
      /version/,
    ],
    ["array of flags", { ...valid, flags: [] }, /snapshot values/],
    [
      "non-finite numeric flag",
      { ...valid, flags: { x: { value: Infinity } } },
      /numeric/,
    ],
    [
      "rollout on non-boolean flag",
      { ...valid, flags: { x: { value: "enabled", rolloutPercent: 50 } } },
      /rollout/,
    ],
    [
      "out-of-range rollout",
      { ...valid, flags: { x: { value: true, rolloutPercent: 101 } } },
      /rollout/,
    ],
  ];

  for (const [label, change, message] of invalidChanges) {
    await assert.rejects(store.apply(change as FlagChange), message, label);
  }
  assert.equal(sends, 0);
});

test("DynamoDB snapshot store requires a non-empty table name", () => {
  const client = { send: async () => undefined, destroy() {} };
  assert.throws(
    () => new DynamoFlagSnapshotStore(client as never, "  "),
    /table name/,
  );
});
