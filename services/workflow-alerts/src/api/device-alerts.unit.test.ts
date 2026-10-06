import assert from "node:assert/strict";
import { test } from "node:test";
import { page } from "./parse.js";
import { listEpisodes } from "../alerts/store.js";
import type { Tx } from "../db/client.js";
const tenant = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const device = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
test("device alert page validates device and retains bounds", () => {
  assert.equal(page("20", undefined, undefined, device).deviceId, device);
  for (const value of [
    "bad",
    tenant.toUpperCase(),
    [device] as unknown as string,
  ])
    assert.throws(() => page("20", undefined, undefined, value));
  assert.throws(() => page("201", undefined, undefined, device));
});
test("device alert query requires same tenant validated inbox association", async () => {
  let query = "",
    params: unknown[] = [];
  const tx = {
    $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
      query = strings.join("?");
      params = values;
      return [];
    },
  } as unknown as Tx;
  assert.deepEqual(
    await listEpisodes(tx, tenant, { limit: 20, deviceId: device }),
    [],
  );
  for (const condition of [
    "e.tenant_id =",
    "i.tenant_id = e.tenant_id",
    "i.event->>'event_type' = 'risk.assessed'",
    "i.event->>'tenant_id' =",
    "e.current_assessment_id::text",
    "'device_id'",
  ])
    assert.ok(query.includes(condition), condition);
  assert.ok(params.includes(tenant));
  assert.ok(params.includes(device));
  assert.equal(params.at(-1), 20);
});
