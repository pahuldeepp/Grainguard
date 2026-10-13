import assert from "node:assert/strict";
import { test } from "node:test";
import {
  parseWatermark,
  serializeWatermark,
  WatermarkError,
} from "./watermark.js";
const token = {
  v: 1 as const,
  tenantId: "11111111-1111-4111-8111-111111111111",
  shardIncarnation: "22222222-2222-4222-8222-222222222222",
  placementEpoch: "9007199254740993",
  sequence: "9223372036854775807",
};
test("watermarks preserve BIGINT precision and bind to the authenticated tenant", () => {
  const serialized = serializeWatermark(token);
  assert.deepEqual(parseWatermark(serialized, token.tenantId), token);
  assert.throws(
    () => parseWatermark(serialized, token.shardIncarnation),
    WatermarkError,
  );
});
test("malformed, overflow, ambiguous and route-hint tokens are rejected", () => {
  for (const value of [
    "",
    "[1]",
    "null",
    "x".repeat(513),
    JSON.stringify({ ...token, shardId: "s2" }),
    JSON.stringify({ ...token, sequence: 1 }),
    JSON.stringify({ ...token, sequence: "01" }),
    JSON.stringify({ ...token, sequence: "9223372036854775808" }),
    JSON.stringify({ ...token, placementEpoch: "0" }),
    JSON.stringify({ ...token, shardIncarnation: "unknown" }),
  ])
    assert.throws(() => parseWatermark(value), WatermarkError);
});
