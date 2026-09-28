import assert from "node:assert/strict";
import { test } from "node:test";
import { hasExactShardedOwnerReceiptSet } from "./placement.js";

const owners = [
  "telemetry",
  "projection",
  "jobs",
  "saga",
  "hardware",
  "inventory",
  "alerts",
  "risk",
  "notifications",
];
const complete = () =>
  Object.fromEntries(owners.map((owner) => [owner, { owner }]));

test("owner cutover gate requires exactly the nine sharded owner claims", () => {
  // Synthetic values exercise roster shape only. They do not prove adapter
  // provenance; the trusted in-process migration controller must supply direct
  // database adapter results. That multi-owner controller does not exist yet.
  assert.equal(
    hasExactShardedOwnerReceiptSet({ ownerReceipts: complete() }),
    true,
  );

  const missing = complete();
  delete missing.notifications;
  assert.equal(
    hasExactShardedOwnerReceiptSet({ ownerReceipts: missing }),
    false,
  );

  const unexpected = {
    ...complete(),
    legacy_primary: { owner: "legacy_primary" },
  };
  assert.equal(
    hasExactShardedOwnerReceiptSet({ ownerReceipts: unexpected }),
    false,
  );

  const misidentified = complete();
  misidentified.risk = { owner: "inventory" };
  assert.equal(
    hasExactShardedOwnerReceiptSet({ ownerReceipts: misidentified }),
    false,
  );

  for (const ownerReceipts of [undefined, null, [], "all owners", {}])
    assert.equal(hasExactShardedOwnerReceiptSet({ ownerReceipts }), false);
});
