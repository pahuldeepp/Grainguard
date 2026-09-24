import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { defaultRule } from "./alerts/policy.js";
import { adminQuery, asTenant } from "./testing/fixtures.js";

const TABLES = [
  "alert_rules",
  "alert_episodes",
  "risk_stream_positions",
  "consumer_inbox",
  "alert_transitions",
  "command_receipts",
  "outbox_events",
];

test("every table has forced RLS and alerts_app holds no DELETE or ownership", async () => {
  const rows = await adminQuery<{
    relname: string;
    forced: boolean;
    enabled: boolean;
    owner: string;
  }>(
    `SELECT c.relname, c.relforcerowsecurity AS forced, c.relrowsecurity AS enabled,
            pg_get_userbyid(c.relowner) AS owner
       FROM pg_class c WHERE c.relkind = 'r' AND c.relnamespace = 'public'::regnamespace
        AND c.relname <> '_prisma_migrations' ORDER BY c.relname`,
  );
  assert.deepEqual(rows.map((r) => r.relname).sort(), [...TABLES].sort());
  for (const r of rows) {
    assert.ok(r.forced && r.enabled, r.relname);
    assert.equal(r.owner, "alerts_migrator");
  }
  const deletes = await adminQuery(
    `SELECT table_name FROM information_schema.role_table_grants
      WHERE grantee = 'alerts_app' AND privilege_type IN ('DELETE', 'TRUNCATE')`,
  );
  assert.deepEqual(deletes, []);
  const [role] = await adminQuery<{ rolbypassrls: boolean; rolsuper: boolean }>(
    "SELECT rolbypassrls, rolsuper FROM pg_roles WHERE rolname = 'alerts_app'",
  );
  assert.deepEqual(role, { rolbypassrls: false, rolsuper: false });
});

test("the episode window key and one-active index reject a second episode", async () => {
  const tenantId = randomUUID();
  const rule = defaultRule(tenantId);
  const binId = randomUUID();
  await asTenant(
    tenantId,
    `INSERT INTO alert_rules (tenant_id, rule_id, rule_key, resource_kind, open_score, clear_score, escalation_timeout_seconds)
     VALUES ($1, $2, $3, 'bin', 40, 25, 900)`,
    [tenantId, rule.ruleId, rule.ruleKey],
  );
  const insert = (window: string) =>
    asTenant(
      tenantId,
      `INSERT INTO alert_episodes (tenant_id, episode_id, rule_id, monitored_resource_id, open_window_start,
         state, severity, score, opened_at, updated_at)
       VALUES ($1, gen_random_uuid(), $2, $3, $4, 'open', 'warning', 50, now(), now())`,
      [tenantId, rule.ruleId, binId, window],
    );
  const results = await Promise.allSettled([
    insert("2026-09-21T15:00:00Z"),
    insert("2026-09-21T15:00:00Z"),
    insert("2026-09-21T15:05:00Z"),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  for (const r of results)
    if (r.status === "rejected")
      assert.match(String(r.reason), /duplicate key/);
});

test("hysteresis thresholds are enforced by the database", async () => {
  const tenantId = randomUUID();
  await assert.rejects(
    asTenant(
      tenantId,
      `INSERT INTO alert_rules (tenant_id, rule_id, rule_key, resource_kind, open_score, clear_score, escalation_timeout_seconds)
       VALUES ($1, gen_random_uuid(), 'bad', 'bin', 30, 30, 900)`,
      [tenantId],
    ),
    /alert_rules_threshold_check/,
  );
});
