import assert from "node:assert/strict";
import { test } from "node:test";
import type { ReadBackends, postgresReads } from "./backends.js";
import { postgresCachePolicy } from "./cache-policy.js";
import { readContext } from "./consistency.js";

test("ordinary primary reads retain Redis; explicit minima and configured replicas bypass uncertified entries", async () => {
  let cachedCalls = 0,
    originCalls = 0;
  const cached = {
    latest: async () => {
      cachedCalls++;
      return "cached";
    },
    history: { list: async () => [] },
    search: { search: async () => [] },
  } as unknown as ReadBackends;
  const origin = {
    latest: async () => {
      originCalls++;
      return "origin";
    },
  } as unknown as ReturnType<typeof postgresReads>;
  const primary = postgresCachePolicy(cached, origin, false);
  assert.equal(await primary.latest("tenant", "device"), "cached");
  const strict = {
    v: 1 as const,
    tenantId: "tenant",
    shardIncarnation: "incarnation",
    placementEpoch: "1",
    sequence: "50",
  };
  assert.equal(
    await readContext.run(
      { tenantId: "tenant", deadline: Date.now() + 1000, minimum: strict },
      () => primary.latest("tenant", "device"),
    ),
    "origin",
  );
  assert.equal(
    await postgresCachePolicy(cached, origin, true).latest("tenant", "device"),
    "origin",
  );
  assert.equal(cachedCalls, 1);
  assert.equal(originCalls, 2);
  assert.equal(primary.history, cached.history);
  assert.equal(primary.search, cached.search);
});
