import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import { after } from "node:test";
import test from "node:test";
import { AuthError, type Principal } from "@greenguard/tenant-auth";
import { testPool } from "./testing/fixtures.js";
import { withTenant } from "./tenant.js";
import { notificationReadHandler } from "./read-api.js";

const tenantA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const intent = "11111111-1111-4111-8111-111111111111";
const principal: Principal = {
  subject: "operator",
  tenantId: tenantA,
  roles: ["operator"],
  expiresAt: new Date(Date.now() + 60_000),
};
const livePool = testPool();
const skipLive = livePool
  ? false
  : "NOTIFICATIONS_DIRECT_URL is not set; run through make";
after(() => livePool?.end());

function deliveryAttemptRow(
  intentId: string,
  severity: "warning" | "critical",
  attemptNo: number,
  attemptTotal: number,
) {
  const timestamp = new Date(`2026-01-01T00:00:0${attemptNo}Z`);
  return {
    intent_id: intentId,
    delivery_generation: severity === "warning" ? 2 : 0,
    channel: severity === "warning" ? "email" : "sms",
    severity,
    status: "sent",
    attempts: attemptTotal,
    reconciles: 0,
    last_error: null,
    created_at: new Date("2026-01-01T00:00:00Z"),
    updated_at: timestamp,
    terminal_at: timestamp,
    attempt_no: attemptNo,
    kind: "send",
    outcome: "sent",
    recorded_at: timestamp,
    attempt_total: attemptTotal,
    attempt_first_at: new Date("2026-01-01T00:00:01Z"),
  };
}

async function serve(
  handler: ReturnType<typeof notificationReadHandler>,
  body: unknown,
) {
  const server = createServer((req, res) => void handler(req, res));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const response = await fetch(
    `http://127.0.0.1:${address.port}/internal/v1/deliveries/lookup`,
    {
      method: "POST",
      headers: {
        authorization: "Bearer verified",
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    },
  );
  const json = await response.json();
  server.close();
  await once(server, "close");
  return { status: response.status, json };
}

test("owner lookup derives tenant from the verified principal and returns sanitized attempts", async () => {
  const calls: Array<{ sql: string; values?: unknown[] }> = [];
  const pool = {
    async connect() {
      return {
        async query(sql: string, values?: unknown[]) {
          calls.push({ sql, values });
          if (sql.includes("WITH requested AS")) {
            const criticalIntent = "22222222-2222-4222-8222-222222222222";
            const seededRows = [
              deliveryAttemptRow(intent, "warning", 1, 2),
              deliveryAttemptRow(intent, "warning", 2, 2),
              ...[1, 2, 3, 4, 5].map((attemptNo) =>
                deliveryAttemptRow(criticalIntent, "critical", attemptNo, 5),
              ),
            ];
            return {
              rows: sql.includes("d.severity = 'warning'")
                ? seededRows.filter((row) => row.severity === "warning")
                : seededRows,
            };
          }
          return { rows: [] };
        },
        release() {},
      };
    },
  } as never;
  const result = await serve(
    notificationReadHandler(pool, async () => principal, "a".repeat(32)),
    {
      pairs: [
        { intentId: intent, deliveryGeneration: 2 },
        {
          intentId: "22222222-2222-4222-8222-222222222222",
          deliveryGeneration: 0,
        },
      ],
      tenantId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    },
  );
  assert.equal(result.status, 200);
  const read = calls.find((call) => call.sql.includes("WITH requested AS"));
  assert.equal(read?.values?.[0], tenantA);
  assert.match(read?.sql ?? "", /d\.tenant_id = \$1/);
  assert.match(read?.sql ?? "", /d\.severity = 'warning'/);
  assert.match(read?.sql ?? "", /warning_delivery\.severity = 'warning'/);
  const serialized = JSON.stringify(result.json);
  assert.ok(!serialized.includes("22222222-2222-4222-8222-222222222222"));
  assert.match(serialized, /"state":"accepted"/);
  const items = (
    result.json as {
      items: Array<{ providerAttempts: number; events: unknown[] }>;
    }
  ).items;
  assert.equal(items.length, 1);
  assert.equal(items[0].providerAttempts, 2);
  assert.equal(items[0].events.length, 2);
  for (const forbidden of [
    "provider_ref",
    "correlation_id",
    "recipient",
    "raw-error",
  ])
    assert.ok(!serialized.includes(forbidden));
});

test("owner lookup denies a viewer before touching the database", async () => {
  let touched = false;
  const pool = {
    async connect() {
      touched = true;
      throw new Error("unexpected database read");
    },
  } as never;
  const result = await serve(
    notificationReadHandler(
      pool,
      async () => {
        throw new AuthError(403, "insufficient_role");
      },
      "a".repeat(32),
    ),
    {
      pairs: [{ intentId: intent, deliveryGeneration: 0 }],
    },
  );
  assert.equal(result.status, 403);
  assert.equal(touched, false);
});

test("owner lookup bounds request size and rejects duplicate generations", async () => {
  const pool = {
    async connect() {
      throw new Error("must not read");
    },
  } as never;
  const handler = notificationReadHandler(
    pool,
    async () => principal,
    "a".repeat(32),
  );
  const duplicate = await serve(handler, {
    pairs: [
      { intentId: intent, deliveryGeneration: 1 },
      { intentId: intent, deliveryGeneration: 1 },
    ],
  });
  assert.equal(duplicate.status, 400);
  const tooMany = await serve(handler, {
    pairs: Array.from({ length: 101 }, (_, i) => ({
      intentId: `11111111-1111-4111-8111-${String(i).padStart(12, "0")}`,
      deliveryGeneration: 0,
    })),
  });
  assert.equal(tooMany.status, 400);
});

test(
  "owner notification history excludes seeded critical deliveries",
  { skip: skipLive },
  async () => {
    const warningIntent = randomUUID();
    const criticalIntent = randomUUID();
    const correlationWarning = randomUUID();
    const correlationCritical = randomUUID();
    await withTenant(livePool!, tenantA, async (client) => {
      await client.query(
        `INSERT INTO deliveries (tenant_id, intent_id, channel, severity, attempts, correlation_id)
         VALUES ($1, $2, 'email', 'warning', 2, $3), ($1, $4, 'sms', 'critical', 5, $5)`,
        [
          tenantA,
          warningIntent,
          correlationWarning,
          criticalIntent,
          correlationCritical,
        ],
      );
      await client.query(
        `INSERT INTO delivery_attempts (tenant_id, intent_id, delivery_generation, attempt_no, kind, outcome, detail)
         VALUES
           ($1, $2, 0, 1, 'send', 'sent', 'warning attempt 1'),
           ($1, $2, 0, 2, 'send', 'sent', 'warning attempt 2'),
           ($1, $3, 0, 1, 'send', 'sent', 'critical attempt 1'),
           ($1, $3, 0, 2, 'send', 'sent', 'critical attempt 2'),
           ($1, $3, 0, 3, 'send', 'sent', 'critical attempt 3'),
           ($1, $3, 0, 4, 'send', 'sent', 'critical attempt 4'),
           ($1, $3, 0, 5, 'send', 'sent', 'critical attempt 5')`,
        [tenantA, warningIntent, criticalIntent],
      );
    });
    const result = await serve(
      notificationReadHandler(livePool!, async () => principal, "a".repeat(32)),
      {
        pairs: [
          { intentId: warningIntent, deliveryGeneration: 0 },
          { intentId: criticalIntent, deliveryGeneration: 0 },
        ],
      },
    );
    assert.equal(result.status, 200);
    const items = (
      result.json as {
        items: Array<{
          intentId: string;
          providerAttempts: number;
          events: unknown[];
        }>;
      }
    ).items;
    assert.deepEqual(
      items.map((item) => item.intentId),
      [warningIntent],
    );
    assert.equal(items[0].providerAttempts, 2);
    assert.equal(items[0].events.length, 2);
  },
);
