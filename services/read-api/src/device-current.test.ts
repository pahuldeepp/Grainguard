import assert from "node:assert/strict";
import { test } from "node:test";
import type { Principal } from "@greenguard/tenant-auth";
import {
  serializeWatermark,
  WATERMARK_REQUEST_HEADER,
  WATERMARK_RESPONSE_HEADER,
  type ReadLeaseAuthority,
} from "@greenguard/membership-client";
import { postgresReads, type ReadBackends } from "./backends.js";
import type { ReplicaProvider } from "./replicas.js";
import { createApp } from "./app.js";
import { readContext, recordSnapshotWatermark } from "./consistency.js";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const D = "33333333-3333-4333-8333-333333333333";
const I = "44444444-4444-4444-8444-444444444444";
const token = (tenantId = A) => ({
  v: 1 as const,
  tenantId,
  shardIncarnation: I,
  placementEpoch: "2",
  sequence: "90",
});
const principal = (tenantId: string): Principal => ({
  tenantId,
  subject: "viewer",
  roles: ["viewer"],
  expiresAt: new Date(Date.now() + 60000),
});

test("device current executes one SQL snapshot with both explicit tenant predicates and one trusted minimum", async () => {
  const calls: Array<{ tenantId: string; sql: string; values: unknown[] }> = [];
  let snapshots = 0,
    demands = 0;
  const provider = {
    async withTenant(
      tenantId: string,
      fn: (tx: {
        query: (sql: string, values: unknown[]) => Promise<unknown>;
      }) => Promise<unknown>,
      minimum: unknown,
    ) {
      snapshots++;
      assert.deepEqual(minimum, token(tenantId));
      return fn({
        query: async (sql, values) => {
          calls.push({ tenantId, sql, values });
          await Promise.resolve();
          assert.deepEqual(values, [tenantId, D]);
          assert.equal(
            (sql.match(/tenant_id=\$1 AND device_id=\$2/g) ?? []).length,
            2,
          );
          assert.match(sql, /LIMIT 1/);
          assert.match(sql, /inventory_version::text/);
          assert.match(sql, /to_jsonb\(r\)->>'stream_version'/);
          return {
            rows: [
              {
                device: {
                  tenant_id: tenantId,
                  device_id: D,
                  inventory_version: "9007199254740993",
                },
                latest_reading:
                  tenantId === A
                    ? {
                        tenant_id: A,
                        device_id: D,
                        reading_id: D,
                        stream_version: "9007199254740993",
                      }
                    : null,
              },
            ],
          };
        },
      });
    },
  } as unknown as ReplicaProvider;
  const read = postgresReads(provider, {
    minimumSequence: async (tenantId) => {
      demands++;
      return token(tenantId);
    },
  });
  const [a, b] = await Promise.all([
    read.deviceCurrent(A, D),
    read.deviceCurrent(B, D),
  ]);
  assert.equal(a.device?.tenant_id, A);
  assert.equal(a.latestReading?.tenant_id, A);
  assert.equal(a.device?.inventory_version, "9007199254740993");
  assert.equal(a.latestReading?.stream_version, "9007199254740993");
  assert.equal(b.device?.tenant_id, B);
  assert.equal(b.latestReading, null);
  assert.equal(snapshots, 2);
  assert.equal(calls.length, 2);
  assert.equal(demands, 2);
});

test("authenticated current operation acquires one lease and certifies one bounded tenant snapshot", async () => {
  let acquisitions = 0,
    admissions = 0,
    releases = 0,
    origins = 0;
  const authority: ReadLeaseAuthority = {
    acquire: async (tenantId) => {
      acquisitions++;
      return {
        leaseId: B,
        expiresAt: new Date(Date.now() + 5000).toISOString(),
        route: {
          tenantId,
          shardId: "s1",
          shardIncarnation: I,
          placementEpoch: "2",
          state: "active",
          expiresAt: new Date(Date.now() + 1000).toISOString(),
        },
      };
    },
    admit: async () => {
      admissions++;
    },
    release: async () => {
      releases++;
    },
  };
  const backends = {
    deviceCurrent: async (tenantId: string, deviceId: string) => {
      origins++;
      assert.equal(deviceId, D);
      const context = readContext.getStore()!;
      assert.equal(context.tenantId, tenantId);
      recordSnapshotWatermark(context, token(tenantId));
      return {
        device: { tenant_id: tenantId, device_id: D },
        latestReading:
          tenantId === A ? { tenant_id: A, device_id: D, reading_id: D } : null,
      };
    },
  } as unknown as ReadBackends;
  const server = createApp({
    historyCursorSecret: "read-api-test-dedicated-cursor-secret-32bytes",
    verify: async (auth) => {
      if (auth !== "A" && auth !== "B") throw new Error("unauthorized");
      return principal(auth === "A" ? A : B);
    },
    backends,
    readAuthority: authority,
  }).listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  try {
    const addr = server.address();
    if (!addr || typeof addr === "string") throw new Error();
    const url = `http://127.0.0.1:${addr.port}/api/v1/read/devices/${D}/current`;
    const response = await fetch(url, {
      headers: {
        Authorization: "A",
        [WATERMARK_REQUEST_HEADER]: serializeWatermark(token()),
      },
    });
    assert.equal(response.status, 200);
    assert.equal(
      response.headers.get(WATERMARK_RESPONSE_HEADER),
      serializeWatermark(token()),
    );
    const value = await response.json();
    assert.equal(value.data.device.tenant_id, A);
    assert.equal(value.data.latestReading.tenant_id, A);
    assert.equal(origins, 1);
    assert.equal(acquisitions, 1);
    assert.equal(admissions, 1);
    assert.equal(releases, 1);
    const foreign = await fetch(url, {
      headers: {
        Authorization: "B",
        [WATERMARK_REQUEST_HEADER]: serializeWatermark(token()),
      },
    });
    assert.equal(foreign.status, 400);
    assert.equal(origins, 1);
    assert.equal(acquisitions, 1);
    const b = await fetch(url, { headers: { Authorization: "B" } });
    assert.equal(b.status, 200);
    const bv = await b.json();
    assert.equal(bv.data.device.tenant_id, B);
    assert.equal(bv.data.latestReading, null);
    assert.equal(
      (
        await fetch(url.replace(D, "invalid"), {
          headers: { Authorization: "A" },
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await fetch(url, {
          headers: { Authorization: "A", [WATERMARK_REQUEST_HEADER]: "broken" },
        })
      ).status,
      400,
    );
    assert.equal(origins, 2);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("current aggregate refuses oversized response payloads", async () => {
  const server = createApp({
    historyCursorSecret: "read-api-test-dedicated-cursor-secret-32bytes",
    verify: async () => principal(A),
    backends: {
      deviceCurrent: async () => ({
        device: { name: "x".repeat(256 * 1024) },
        latestReading: null,
      }),
    } as unknown as ReadBackends,
  }).listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  try {
    const addr = server.address();
    if (!addr || typeof addr === "string") throw new Error();
    const response = await fetch(
      `http://127.0.0.1:${addr.port}/api/v1/read/devices/${D}/current`,
    );
    assert.equal(response.status, 422);
    assert.equal((await response.json()).code, "response_too_large");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
