import assert from "node:assert/strict";
import { test } from "node:test";
import { discoverBucket, IpTokenBucket } from "./rate-limit.js";

test("token bucket allows a burst, then returns Retry-After seconds, then refills", () => {
  const bucket = new IpTokenBucket({
    capacity: 2,
    refillPerSecond: 1,
    maxEntries: 10,
  });
  assert.equal(bucket.take("1.1.1.1", 0), 0);
  assert.equal(bucket.take("1.1.1.1", 0), 0);
  assert.equal(bucket.take("1.1.1.1", 0), 1);
  assert.equal(bucket.take("2.2.2.2", 0), 0);
  assert.equal(bucket.take("1.1.1.1", 1000), 0);
});

test("token bucket memory is bounded and evicts the oldest address", () => {
  const bucket = new IpTokenBucket({
    capacity: 1,
    refillPerSecond: 0.001,
    maxEntries: 3,
  });
  for (const ip of ["a", "b", "c", "d"]) bucket.take(ip, 0);
  assert.equal(bucket.size, 3);
  assert.equal(bucket.take("a", 0), 0);
});

test("discovery bucket rejects non-finite limits without changing valid defaults", () => {
  assert.equal(discoverBucket({}).take("a", 0), 0);
  for (const env of [
    { IDENTITY_DISCOVER_BURST: "NaN" },
    { IDENTITY_DISCOVER_BURST: "Infinity" },
    { IDENTITY_DISCOVER_PER_MINUTE: "NaN" },
    { IDENTITY_DISCOVER_PER_MINUTE: "Infinity" },
  ])
    assert.throws(() => discoverBucket(env), /must be positive/);
});
