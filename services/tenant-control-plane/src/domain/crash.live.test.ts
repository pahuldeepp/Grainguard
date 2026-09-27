import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { nameId } from "./ids.js";
import { adminQuery, ISSUER } from "../testing/fixtures.js";

const worker = fileURLToPath(new URL("./crash-worker.js", import.meta.url));
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function runWorker(
  mode: string,
  subject: string,
  key: string,
  name: string,
  beforeKill?: (pid: number) => Promise<void>,
) {
  const child = spawn(process.execPath, [worker, mode, subject, key, name], {
    env: process.env,
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });
  const exit = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  if (beforeKill) await beforeKill(child.pid!);
  const result = await exit;
  assert.equal(result.signal, "SIGKILL", stderr);
}

async function effects(tenantId: string) {
  const [row] = await adminQuery<{
    organizations: number;
    memberships: number;
    audits: number;
    outbox: number;
    receipts: number;
  }>(
    `
    SELECT
      (SELECT count(*)::int FROM organizations WHERE tenant_id=$1) AS organizations,
      (SELECT count(*)::int FROM memberships WHERE tenant_id=$1) AS memberships,
      (SELECT count(*)::int FROM membership_events WHERE tenant_id=$1) AS audits,
      (SELECT count(*)::int FROM outbox_events WHERE tenant_id=$1) AS outbox,
      (SELECT count(*)::int FROM command_receipts WHERE tenant_id=$1) AS receipts`,
    [tenantId],
  );
  return row;
}

test("M09 opt-in process crash before and after commit preserves atomic effects", async (t) => {
  if (process.env.STAGE09_CRASH_LIVE !== "1") {
    t.skip("STAGE09_CRASH_LIVE=1 required");
    return;
  }
  const marker = randomBytes(6).toString("hex");
  const name = `m09-before-${marker}`;
  const subject = `m09-${marker}`;
  const key = randomUUID();
  const tenantId = nameId("organization", ISSUER, subject, key);
  const functionName = `m09_pause_${marker}`;
  const triggerName = `m09_pause_${marker}`;
  await adminQuery(`CREATE FUNCTION ${functionName}() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.event_type = 'tenant.created' AND NEW.payload->>'name' = '${name}'
      THEN PERFORM pg_sleep(30); END IF; RETURN NEW; END $$`);
  await adminQuery(`CREATE TRIGGER ${triggerName} BEFORE INSERT ON outbox_events
    FOR EACH ROW EXECUTE FUNCTION ${functionName}()`);
  try {
    await runWorker("before", subject, key, name, async (pid) => {
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        const [row] = await adminQuery<{ n: number }>(`
          SELECT count(*)::int AS n FROM pg_stat_activity
          WHERE datname='greenguard_control' AND wait_event='PgSleep'
            AND query ILIKE '%INSERT INTO outbox_events%'`);
        if (row?.n) {
          process.kill(pid, "SIGKILL");
          return;
        }
        await pause(50);
      }
      process.kill(pid, "SIGKILL");
      throw new Error(
        "the test never observed the transaction paused before commit",
      );
    });
    assert.deepEqual(await effects(tenantId), {
      organizations: 0,
      memberships: 0,
      audits: 0,
      outbox: 0,
      receipts: 0,
    });
  } finally {
    await adminQuery(`DROP TRIGGER IF EXISTS ${triggerName} ON outbox_events`);
    await adminQuery(`DROP FUNCTION IF EXISTS ${functionName}()`);
  }
  // The same request now commits. Killing the caller immediately after the
  // transaction returns cannot erase any of the database effects.
  await runWorker("after", subject, key, name);
  assert.deepEqual(await effects(tenantId), {
    organizations: 1,
    memberships: 1,
    audits: 2,
    outbox: 2,
    receipts: 1,
  });
});
