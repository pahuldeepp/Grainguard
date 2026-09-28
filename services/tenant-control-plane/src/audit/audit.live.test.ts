import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import {
  verifySignedAuditExport,
  writeSignedAuditExport,
  type AuditManifest,
} from "@greenguard/audit";
import {
  createOrganization,
  inviteMember,
  acceptInvitation,
  type Actor,
} from "../domain/store.js";
import {
  adminQuery,
  asRuntime,
  runtimeDb,
  uniqueSubject,
} from "../testing/fixtures.js";
import {
  auditJobRows,
  claimAuditJob,
  getAuditJob,
  listAuditPage,
  requestAuditExport,
} from "./store.js";
import { processNextAuditExport } from "./worker.js";
import { RoleForbiddenError } from "../domain/errors.js";
import { AuditSources } from "./owners.js";
import { env } from "../testing/fixtures.js";
import { seedPlan } from "../testing/entitlements.js";
import pg from "pg";

const db = runtimeDb(5);
const keys = generateKeyPairSync("ed25519");
const dir = await mkdtemp(path.join(os.tmpdir(), "greenguard-audit-live-"));
after(async () => {
  await db.$disconnect();
  await rm(dir, { recursive: true, force: true });
});
const cmd = () => ({
  idempotencyKey: randomUUID(),
  correlationId: randomUUID(),
  traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
});
const actor = (name: string): Actor => {
  const subject = uniqueSubject(name);
  return {
    issuer: "https://issuer.test",
    subject,
    email: `${subject}@example.test`,
    emailVerified: true,
  };
};
async function org(name: string) {
  const admin = actor(name);
  const created = await createOrganization(db, admin, { name }, cmd());
  const tenantId = created.body.tenantId as string;
  await seedPlan(tenantId, { "exports.per_day": 50 }, { audit_export: true });
  return { admin, tenantId };
}

test("A01 A02 A05 A07 A08 tenant isolation, stable cursor, durable signed retry, audit, role", async () => {
  const a = await org("audit-a"),
    b = await org("audit-b");
  const page = await listAuditPage(db, a.admin, a.tenantId, { limit: 1 });
  assert.equal(page.items.length, 1);
  assert.equal(page.items[0]?.tenantId, a.tenantId);
  assert(page.nextCursor === null || typeof page.nextCursor === "string");
  await assert.rejects(
    listAuditPage(db, b.admin, a.tenantId, {}),
    RoleForbiddenError,
  );
  const rls = await asRuntime(
    { "app.tenant_id": a.tenantId },
    "SELECT count(*)::int AS n FROM membership_events WHERE tenant_id=$1",
    [b.tenantId],
  );
  assert.equal(rls.rows[0].n, 0);
  const viewer = actor("audit-viewer");
  const invited = await inviteMember(
    db,
    a.admin,
    a.tenantId,
    { email: `${viewer.subject}@example.test`, role: "viewer" },
    cmd(),
  );
  await acceptInvitation(
    db,
    viewer,
    { token: invited.body.token as string },
    cmd(),
  );
  await assert.rejects(
    listAuditPage(db, viewer, a.tenantId, {}),
    RoleForbiddenError,
  );
  const end = new Date().toISOString();
  const first = await listAuditPage(db, a.admin, a.tenantId, { limit: 1 });
  assert(first.nextCursor);
  const inserted = await inviteMember(
    db,
    a.admin,
    a.tenantId,
    { email: `late-${uniqueSubject("cursor")}@example.test`, role: "viewer" },
    cmd(),
  );
  assert(inserted.body);
  const second = await listAuditPage(db, a.admin, a.tenantId, {
    limit: 1,
    cursor: first.nextCursor,
  });
  assert(second.items.every((x) => x.auditId !== first.items[0]?.auditId));
  assert(second.items.every((x) => x.occurredAt <= end));

  const requested = await requestAuditExport(
    db,
    a.admin,
    a.tenantId,
    {
      from: "2020-01-01T00:00:00Z",
      to: new Date().toISOString(),
      format: "jsonl",
    },
    cmd(),
  );
  const actions = await adminQuery<{ n: string }>(
    "SELECT count(*)::text AS n FROM audit_export_actions WHERE tenant_id=$1 AND job_id=$2 AND action='requested'",
    [a.tenantId, requested.jobId],
  );
  assert.equal(actions[0]?.n, "1");
  assert.equal(
    await processNextAuditExport(db, {
      destinationDirectory: dir,
      privateKey: keys.privateKey,
      publicKeyId: "live-test",
    }),
    true,
  );
  const ready = await getAuditJob(db, a.admin, a.tenantId, requested.jobId);
  assert.equal(ready.state, "ready");
  const file = await readFile(path.join(dir, requested.jobId, "audit.jsonl"));
  const manifest = JSON.parse(
    await readFile(path.join(dir, requested.jobId, "manifest.json"), "utf8"),
  ) as AuditManifest;
  const signature = await readFile(
    path.join(dir, requested.jobId, "signature"),
    "utf8",
  );
  assert(
    verifySignedAuditExport({
      file,
      manifest,
      signature,
      publicKey: keys.publicKey,
    }),
  );
  assert(!file.toString().includes(b.tenantId));
  assert(file.toString().includes(a.tenantId));
  assert.equal(
    await processNextAuditExport(db, {
      destinationDirectory: dir,
      privateKey: keys.privateKey,
      publicKeyId: "live-test",
    }),
    false,
  );
  await assert.rejects(getAuditJob(db, b.admin, b.tenantId, requested.jobId));
});

test("A01 A03 owner reads include inventory and billing under RLS; CSV verifies", async () => {
  const a = await org("audit-owners-a"),
    b = await org("audit-owners-b");
  async function insert(
    database: string,
    tenantId: string,
    sql: string,
    params: unknown[],
  ) {
    const url = new URL(env("POSTGRES_ADMIN_URL"));
    url.pathname = `/${database}`;
    const client = new pg.Client({ connectionString: url.toString() });
    await client.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.tenant_id',$1,true)", [
        tenantId,
      ]);
      const [{ present }] = (
        await client.query<{ present: boolean }>(
          "SELECT to_regclass('greenguard_internal.tenant_ownership') IS NOT NULL AS present",
        )
      ).rows;
      if (present) {
        await client.query(
          "INSERT INTO greenguard_internal.tenant_ownership(tenant_id,shard_id,shard_incarnation,placement_epoch,state) VALUES($1,'s1',$2,1,'active') ON CONFLICT(tenant_id) DO NOTHING",
          [tenantId, "20000000-0000-4000-8000-000000000001"],
        );
        const [owner] = (
          await client.query<{
            shard_id: string;
            shard_incarnation: string;
            placement_epoch: string;
          }>(
            "SELECT shard_id,shard_incarnation::text,placement_epoch::text FROM greenguard_internal.tenant_ownership WHERE tenant_id=$1",
            [tenantId],
          )
        ).rows;
        await client.query(
          "SELECT set_config('app.shard_id',$1,true),set_config('app.shard_incarnation',$2,true),set_config('app.placement_epoch',$3,true)",
          [owner.shard_id, owner.shard_incarnation, owner.placement_epoch],
        );
      }
      await client.query(sql, params);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      await client.end();
    }
  }
  const inventoryId = randomUUID(),
    billingId = randomUUID(),
    foreignId = randomUUID();
  await insert(
    "greenguard_inventory",
    a.tenantId,
    `INSERT INTO audit_events
    (audit_id,tenant_id,actor_type,actor_id,action,resource_type,resource_id,command_id,outcome,occurred_at)
    VALUES($1,$2,'human','owner-a','device.created','device',$3,$4,'succeeded',now())`,
    [inventoryId, a.tenantId, randomUUID(), randomUUID()],
  );
  await insert(
    "greenguard_inventory",
    b.tenantId,
    `INSERT INTO audit_events
    (audit_id,tenant_id,actor_type,actor_id,action,resource_type,resource_id,command_id,outcome,occurred_at)
    VALUES($1,$2,'human','owner-b','device.created','device',$3,$4,'succeeded',now())`,
    [foreignId, b.tenantId, randomUUID(), randomUUID()],
  );
  await insert(
    "greenguard_billing",
    a.tenantId,
    `INSERT INTO billing_audit_events
    (tenant_id,audit_id,actor_id,action,object_id,detail)
    VALUES($1,$2,'system','billing.subscription.changed','sub-1','{"secret":"must-not-export"}'::jsonb)`,
    [a.tenantId, billingId],
  );
  const sources = new AuditSources(
    env("INVENTORY_DATABASE_URL"),
    env("BILLING_DATABASE_URL"),
  );
  try {
    const page = await listAuditPage(
      db,
      a.admin,
      a.tenantId,
      { limit: 500 },
      sources,
    );
    assert(page.items.some((x) => x.auditId === inventoryId));
    assert(page.items.some((x) => x.auditId === billingId));
    assert(!page.items.some((x) => x.auditId === foreignId));
    const ownerRows = await sources.read(
      "inventory",
      a.tenantId,
      new Date("2020-01-01"),
      new Date("9999-01-01"),
      null,
      500,
    );
    assert(!ownerRows.some((x) => x.auditId === foreignId));
    const requested = await requestAuditExport(
      db,
      a.admin,
      a.tenantId,
      {
        from: "2020-01-01T00:00:00Z",
        to: new Date().toISOString(),
        format: "csv",
      },
      cmd(),
    );
    assert.equal(
      await processNextAuditExport(db, {
        destinationDirectory: dir,
        privateKey: keys.privateKey,
        publicKeyId: "live-test",
        sources,
      }),
      true,
    );
    const ready = await getAuditJob(db, a.admin, a.tenantId, requested.jobId);
    assert.equal(ready.state, "ready");
    const file = await readFile(path.join(dir, requested.jobId, "audit.csv"));
    const manifest = JSON.parse(
      await readFile(path.join(dir, requested.jobId, "manifest.json"), "utf8"),
    ) as AuditManifest;
    const signature = await readFile(
      path.join(dir, requested.jobId, "signature"),
      "utf8",
    );
    assert(
      verifySignedAuditExport({
        file,
        manifest,
        signature,
        publicKey: keys.publicKey,
      }),
    );
    assert(file.toString().includes(inventoryId));
    assert(file.toString().includes(billingId));
    assert(!file.toString().includes(foreignId));
    assert(!file.toString().includes("must-not-export"));
  } finally {
    await sources.close();
  }
});

test("A05 worker crash leaves a reclaimable job and one completed output", async () => {
  const a = await org("audit-crash");
  const requested = await requestAuditExport(
    db,
    a.admin,
    a.tenantId,
    {
      from: "2020-01-01T00:00:00Z",
      to: new Date().toISOString(),
      format: "jsonl",
    },
    cmd(),
  );
  const claimed = await claimAuditJob(db);
  assert.equal(claimed?.job_id, requested.jobId);
  async function* interrupted() {
    yield* auditJobRows(db, claimed!);
    throw new Error("simulated worker crash");
  }
  await assert.rejects(
    writeSignedAuditExport({
      tenantId: a.tenantId,
      jobId: requested.jobId,
      rows: interrupted(),
      destinationDirectory: dir,
      privateKey: keys.privateKey,
      publicKeyId: "live-test",
    }),
    /simulated worker crash/,
  );
  await adminQuery(
    "UPDATE audit_export_jobs SET lease_until=now()-interval '1 second' WHERE tenant_id=$1 AND job_id=$2",
    [a.tenantId, requested.jobId],
  );
  assert.equal(
    await processNextAuditExport(db, {
      destinationDirectory: dir,
      privateKey: keys.privateKey,
      publicKeyId: "live-test",
    }),
    true,
  );
  const ready = await getAuditJob(db, a.admin, a.tenantId, requested.jobId);
  assert.equal(ready.state, "ready");
  const [count] = await adminQuery<{ n: string }>(
    "SELECT count(*)::text AS n FROM audit_export_jobs WHERE tenant_id=$1 AND job_id=$2",
    [a.tenantId, requested.jobId],
  );
  assert.equal(count?.n, "1");
  const [attempts] = await adminQuery<{ attempts: number }>(
    "SELECT attempts FROM audit_export_jobs WHERE tenant_id=$1 AND job_id=$2",
    [a.tenantId, requested.jobId],
  );
  assert.equal(attempts?.attempts, 2);
});
