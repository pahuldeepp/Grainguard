import assert from "node:assert/strict";
import { test } from "node:test";
import type { AddressInfo } from "node:net";
import type { Principal } from "@greenguard/tenant-auth";
import { createApp } from "./app.js";
import {
  postgresReads,
  type ReadBackends,
  type HistoryQuery,
} from "./backends.js";
import type { ReplicaProvider } from "./replicas.js";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const D = "33333333-3333-4333-8333-333333333333";
const from = new Date("2026-10-03T00:00:00Z");
const to = new Date("2026-10-04T00:00:00Z");

test("risk uses one admitted tenant snapshot, explicit tenant filters and bounded lookahead", async () => {
  const tenants: string[] = [];
  const provider = {
    withTenant: async (
      tenant: string,
      run: (tx: unknown) => Promise<unknown>,
    ) => {
      tenants.push(tenant);
      return run({
        query: async (sql: string, values: unknown[]) => {
          assert.deepEqual(values, [tenant, D, from, to, 2]);
          assert.equal(
            (sql.match(/tenant_id=\$1 AND device_id=\$2/g) ?? []).length,
            3,
          );
          assert.match(sql, /FROM read\.risk_assessments/);
          assert.match(
            sql,
            /NOT EXISTS\(SELECT 1 FROM read\.risk_assessment_invalidations/,
          );
          assert.match(sql, /i\.tenant_id=ra\.tenant_id/);
          assert.match(sql, /occurred_at >= \$3 AND occurred_at < \$4/);
          assert.match(sql, /LIMIT \$5/);
          assert.match(sql, /policy_version::text/);
          return {
            rows: [
              {
                known: tenant === A,
                assessments:
                  tenant === A
                    ? [
                        {
                          assessment_id: D,
                          policy_version: "9007199254740993",
                          score: 20,
                        },
                        { assessment_id: A, score: 30 },
                      ]
                    : [],
              },
            ],
          };
        },
      });
    },
  } as unknown as ReplicaProvider;
  const reads = postgresReads(provider);
  const own = await reads.deviceRisk({
    tenantId: A,
    deviceId: D,
    from,
    to,
    limit: 1,
  });
  assert.equal(own.status, "available");
  assert.equal(own.assessments.length, 1);
  assert.equal(own.assessments[0]!.policy_version, "9007199254740993");
  assert.equal(own.truncated, true);
  assert.equal(own.validity, "unverified");
  assert.equal(own.actionable, false);
  assert.match(
    own.caveat,
    /known withdrawn or superseded assessments are excluded/,
  );
  const foreign = await reads.deviceRisk({
    tenantId: B,
    deviceId: D,
    from,
    to,
    limit: 1,
  });
  assert.equal(foreign.status, "device_not_found");
  assert.deepEqual(foreign.assessments, []);
  assert.deepEqual(tenants, [A, B]);
});

test("delegated risk validates bounds, entitlements and ignores no caller identity", async () => {
  const calls: string[] = [];
  const data = {
    status: "no_assessments" as const,
    assessments: [],
    truncated: false,
    validity: "unverified" as const,
    actionable: false as const,
    caveat: "Historical only",
  };
  const app = createApp({
    historyCursorSecret: "device-risk-test-cursor-secret-at-least-32-bytes",
    now: () => new Date("2026-10-04T01:00:00Z"),
    verify: async (header) =>
      ({
        tenantId: header === "Bearer foreign" ? B : A,
        subject: "viewer",
        roles: ["viewer"],
        expiresAt: new Date(Date.now() + 60000),
        actor: "greenguard-mcp",
        audience: "read-api",
        scopes: ["telemetry:read"],
      }) as Principal,
    backends: {
      deviceRisk: async (q: HistoryQuery) => {
        calls.push(q.tenantId);
        assert.equal(q.deviceId, D);
        assert.equal(q.limit, 1);
        return data;
      },
    } as unknown as ReadBackends,
  }).listen(0);
  try {
    const url = `http://127.0.0.1:${(app.address() as AddressInfo).port}/api/v1/read/devices/${D}/risk`;
    const query = `?from=${from.toISOString()}&to=${to.toISOString()}&limit=1`;
    const get = (suffix: string, token = "own") =>
      fetch(url + suffix, { headers: { Authorization: `Bearer ${token}` } });
    const response = await get(query);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(body.data, data);
    assert.equal(body.source, "postgres");
    assert.equal(body.from, from.toISOString());
    assert.equal((await get(query, "foreign")).status, 200);
    assert.deepEqual(calls, [A, B]);
    for (const invalid of [
      query + `&tenantId=${B}`,
      query + "&sql=SELECT",
      query.replace("limit=1", "limit=101"),
      query.replace(to.toISOString(), "2026-10-05T00:00:00Z"),
      "?from=2026-09-01T00:00:00Z&to=2026-10-04T00:00:00Z",
    ]) {
      assert.equal((await get(invalid)).status, 400);
    }
    assert.equal(
      (await get("?from=2026-09-25T00:00:00Z&to=2026-10-04T00:00:00Z")).status,
      403,
    );
    assert.deepEqual(calls, [A, B]);
  } finally {
    await new Promise<void>((resolve) => app.close(() => resolve()));
  }
});
