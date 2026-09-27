import assert from "node:assert/strict";
import { test } from "node:test";
import { canonicalId, stableUuid } from "./contract.js";

test("canonical IDs and full signed-64-bit coordinate IDs match the Python normalizer", () => {
  assert.equal(
    canonicalId(
      "partner-a",
      "123e4567-e89b-42d3-a456-426614174000",
      "site",
      "site-1",
    ),
    "62d4a86b-b86a-587f-952c-d9442fe56821",
  );
  assert.equal(
    stableUuid("a00f2290-bf1c-5eb9-b19a-54f3acb29355", [
      "partner-a",
      "generation-1",
      "partner.inventory_sites",
      0,
      9223372036854775807n,
    ]),
    "257ef963-53fc-5f76-8e93-a28a80ce08e8",
  );
});
