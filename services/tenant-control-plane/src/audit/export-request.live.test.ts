import assert from "node:assert/strict";
import { after, test } from "node:test";
import { RateLimitedError } from "../api/rate-limited.js";
import { IdempotencyConflictError } from "../domain/errors.js";
import { setFeedAge } from "../testing/entitlements.js";
import { adminQuery, runtimeDb } from "../testing/fixtures.js";
import { command, seedOrg, wholeRange } from "./storage-fixtures.js";
import { requestAuditExport } from "./store.js";

const db = runtimeDb(8);
const tenants: string[] = [];
const newOrg = async (label: string, perDay?: number) => {
  const seeded = await seedOrg(db, label, perDay);
  tenants.push(seeded.tenantId);
  return seeded;
};
// These tests only request jobs; park them so a worker in another test never claims them.
after(async () => {
  await adminQuery(
    "UPDATE audit_export_jobs SET state='ready' WHERE tenant_id = ANY($1::uuid[]) AND state='queued'",
    [tenants],
  );
  await db.$disconnect();
});
const csv = (range: { from: string; to: string }) => ({
  ...range,
  format: "csv" as const,
});
const jobs = async (tenantId: string) =>
  Number(
    (
      await adminQuery<{ n: string }>(
        "SELECT count(*)::text AS n FROM audit_export_jobs WHERE tenant_id=$1",
        [tenantId],
      )
    )[0]!.n,
  );
const requested = async (tenantId: string) =>
  Number(
    (
      await adminQuery<{ n: string }>(
        "SELECT count(*)::text AS n FROM audit_export_actions WHERE tenant_id=$1 AND action='requested'",
        [tenantId],
      )
    )[0]!.n,
  );

test("EQ1 an idempotent replay returns the same job and creates nothing new", async () => {
  const org = await newOrg("eq1");
  const cmd = command();
  const range = csv(wholeRange());
  const first = await requestAuditExport(
    db,
    org.admin,
    org.tenantId,
    range,
    cmd,
  );
  const again = await requestAuditExport(
    db,
    org.admin,
    org.tenantId,
    range,
    cmd,
  );
  assert.equal(again.jobId, first.jobId);
  assert.deepEqual(
    [await jobs(org.tenantId), await requested(org.tenantId)],
    [1, 1],
  );
});

test("EQ2 the same key with a different request is a conflict", async () => {
  const org = await newOrg("eq2");
  const cmd = command();
  await requestAuditExport(db, org.admin, org.tenantId, csv(wholeRange()), cmd);
  await assert.rejects(
    requestAuditExport(
      db,
      org.admin,
      org.tenantId,
      { ...wholeRange(), from: "2021-01-01T00:00:00Z", format: "csv" },
      cmd,
    ),
    IdempotencyConflictError,
  );
});

test("EQ3 exports.per_day is enforced with a Retry-After, replays at the limit still succeed, tenants are independent", async () => {
  const a = await newOrg("eq3a", 2),
    b = await newOrg("eq3b", 2);
  const second = command();
  const range = csv(wholeRange());
  await requestAuditExport(
    db,
    a.admin,
    a.tenantId,
    csv(wholeRange()),
    command(),
  );
  const kept = await requestAuditExport(db, a.admin, a.tenantId, range, second);
  await assert.rejects(
    requestAuditExport(db, a.admin, a.tenantId, csv(wholeRange()), command()),
    (e: unknown) =>
      e instanceof RateLimitedError &&
      e.retryAfter > 0 &&
      e.retryAfter <= 86_400,
  );
  assert.equal(
    (await requestAuditExport(db, a.admin, a.tenantId, range, second)).jobId,
    kept.jobId,
  );
  assert.equal(await jobs(a.tenantId), 2);
  await requestAuditExport(
    db,
    b.admin,
    b.tenantId,
    csv(wholeRange()),
    command(),
  );
  assert.equal(await jobs(b.tenantId), 1);
});

test("EQ4 a plan without an exports.per_day allowance gets the free default of zero", async () => {
  const org = await newOrg("eq4", 0);
  await assert.rejects(
    requestAuditExport(
      db,
      org.admin,
      org.tenantId,
      csv(wholeRange()),
      command(),
    ),
    RateLimitedError,
  );
  assert.equal(await jobs(org.tenantId), 0);
  await adminQuery(
    "UPDATE tenant_entitlements SET limits='{}'::jsonb WHERE tenant_id=$1",
    [org.tenantId],
  );
  await assert.rejects(
    requestAuditExport(
      db,
      org.admin,
      org.tenantId,
      csv(wholeRange()),
      command(),
    ),
    RateLimitedError,
  );
});

test("EQ5 concurrent requests cannot exceed the daily quota", async () => {
  const org = await newOrg("eq5", 2);
  const results = await Promise.allSettled(
    Array.from({ length: 6 }, () =>
      requestAuditExport(
        db,
        org.admin,
        org.tenantId,
        csv(wholeRange()),
        command(),
      ),
    ),
  );
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 2);
  assert.equal(
    results.filter(
      (r) => r.status === "rejected" && r.reason instanceof RateLimitedError,
    ).length,
    4,
  );
  assert.equal(await jobs(org.tenantId), 2);
});

const ask = (org: {
  admin: Parameters<typeof requestAuditExport>[1];
  tenantId: string;
}) =>
  requestAuditExport(db, org.admin, org.tenantId, csv(wholeRange()), command());

test("EQ6 a healthy feed honors the paid plan's exports.per_day", async () => {
  const org = await newOrg("eq6", 2);
  await setFeedAge(0);
  await ask(org);
  await ask(org);
  await assert.rejects(ask(org), RateLimitedError);
  assert.equal(await jobs(org.tenantId), 2);
});

test("EQ7 a stale or absent feed fails closed to the free default with the same 429", async () => {
  const org = await newOrg("eq7", 50);
  for (const age of [600, null]) {
    await setFeedAge(age);
    await assert.rejects(
      ask(org),
      (e: unknown) => e instanceof RateLimitedError && e.retryAfter > 0,
    );
  }
  assert.equal(await jobs(org.tenantId), 0);
  await setFeedAge(0);
  await ask(org);
  assert.equal(await jobs(org.tenantId), 1);
});

test("EQ8 the quota counts only today's jobs (UTC day)", async () => {
  const org = await newOrg("eq8", 1);
  await ask(org);
  await assert.rejects(ask(org), RateLimitedError);
  await adminQuery(
    "UPDATE audit_export_jobs SET created_at=created_at-interval '1 day' WHERE tenant_id=$1",
    [org.tenantId],
  );
  await ask(org);
  assert.equal(await jobs(org.tenantId), 2);
});
