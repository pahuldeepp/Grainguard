import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { adminQuery, runtimeDb } from "../testing/fixtures.js";
import {
  FaultyStorage,
  jobRow,
  queuedExport,
  skipBackoff,
} from "./storage-fixtures.js";
import { processNextAuditExport } from "./worker.js";

const db = runtimeDb(5);
const keys = generateKeyPairSync("ed25519");
const work = await mkdtemp(path.join(os.tmpdir(), "greenguard-audit-work-"));
after(async () => {
  await db.$disconnect();
  await rm(work, { recursive: true, force: true });
});
const noSleep = async () => undefined;
const options = (storage: FaultyStorage) => ({
  storage,
  privateKey: keys.privateKey,
  publicKeyId: "s3-test",
  workDirectory: work,
  retry: { attempts: 3, baseDelayMs: 1 },
  sleep: noSleep,
});
const denied = () =>
  Object.assign(new Error("access denied"), {
    name: "AccessDenied",
    $metadata: { httpStatusCode: 403 },
  });
const slow = () =>
  Object.assign(new Error("slow down"), {
    name: "SlowDown",
    $metadata: { httpStatusCode: 503 },
  });

test("S3W1 a failed upload never completes the job, cleans temp files and is requeued with backoff", async () => {
  const job = await queuedExport(db, "s3w1");
  const storage = new FaultyStorage();
  storage.failOn = () => denied();
  await assert.rejects(
    processNextAuditExport(db, options(storage)),
    /access denied/,
  );
  assert.equal((await jobRow(job.tenantId, job.jobId)).state, "queued");
  assert.deepEqual(await readdir(work), []);
  await skipBackoff(job.tenantId, job.jobId);
  storage.failOn = null;
  assert.equal(await processNextAuditExport(db, options(storage)), true);
  assert.equal((await jobRow(job.tenantId, job.jobId)).state, "ready");
  assert.equal(storage.objects.size, 3);
});

test("S3W2 transient upload errors retry and the job completes once", async () => {
  const job = await queuedExport(db, "s3w2", "csv");
  const storage = new FaultyStorage();
  storage.failOn = (_key, attempt) => (attempt <= 2 ? slow() : null);
  assert.equal(await processNextAuditExport(db, options(storage)), true);
  const row = await jobRow(job.tenantId, job.jobId);
  assert.deepEqual(
    { state: row.state, attempts: row.attempts },
    { state: "ready", attempts: 1 },
  );
  assert.equal(storage.objects.size, 3);
});

test("S3W3 a half-uploaded job (manifest missing) is not ready and recovers to one object set", async () => {
  const job = await queuedExport(db, "s3w3");
  const storage = new FaultyStorage();
  storage.failOn = (key) => (key.endsWith("/manifest.json") ? denied() : null);
  await assert.rejects(
    processNextAuditExport(db, options(storage)),
    /access denied/,
  );
  assert.equal(storage.objects.size, 2);
  assert.equal((await jobRow(job.tenantId, job.jobId)).state, "queued");
  await skipBackoff(job.tenantId, job.jobId);
  storage.failOn = null;
  assert.equal(await processNextAuditExport(db, options(storage)), true);
  const row = await jobRow(job.tenantId, job.jobId);
  assert.deepEqual(
    { state: row.state, attempts: row.attempts },
    { state: "ready", attempts: 2 },
  );
  assert.equal(
    storage.objects.size,
    3,
    "same deterministic keys are overwritten, never duplicated",
  );
});

test("S3W4 an object that fails head verification never marks the job ready", async () => {
  const job = await queuedExport(db, "s3w4");
  const storage = new FaultyStorage();
  storage.tamper = (stored) => ({ ...stored, sha256: "00" });
  await assert.rejects(
    processNextAuditExport(db, options(storage)),
    /checksum|differs/,
  );
  assert.equal((await jobRow(job.tenantId, job.jobId)).state, "queued");
  assert.deepEqual(await readdir(work), []);
  storage.tamper = null;
  await skipBackoff(job.tenantId, job.jobId);
  assert.equal(
    await processNextAuditExport(db, options(storage)),
    true,
    "an untampered retry completes it",
  );
  assert.equal((await jobRow(job.tenantId, job.jobId)).state, "ready");
});

test("S3W5 failures back off, are capped, and end in a failed state with a bounded error", async () => {
  const poisoned = await queuedExport(db, "s3w5");
  const storage = new FaultyStorage();
  storage.failOn = () =>
    Object.assign(new Error(`boom ${"x".repeat(2000)}`), {
      name: "AccessDenied",
      $metadata: { httpStatusCode: 403 },
    });
  for (let attempt = 1; attempt <= 4; attempt++) {
    await assert.rejects(processNextAuditExport(db, options(storage)), /boom/);
    const row = await jobRow(poisoned.tenantId, poisoned.jobId);
    assert.deepEqual(
      { state: row.state, attempts: row.attempts },
      { state: "queued", attempts: attempt },
    );
    assert.ok(
      row.next_attempt_at &&
        row.next_attempt_at.getTime() > Date.now() + 20_000,
      "backoff of at least 30s",
    );
    assert.equal(
      await processNextAuditExport(db, options(storage)),
      false,
      "not claimable during backoff",
    );
    await skipBackoff(poisoned.tenantId, poisoned.jobId);
  }
  await assert.rejects(processNextAuditExport(db, options(storage)), /boom/);
  const failed = await jobRow(poisoned.tenantId, poisoned.jobId);
  assert.equal(failed.state, "failed");
  assert.equal(failed.attempts, 5);
  assert.ok(failed.failed_at);
  assert.match(failed.last_error ?? "", /^AccessDenied: boom/);
  assert.ok((failed.last_error ?? "").length <= 500);
  assert.equal(failed.next_attempt_at, null);
  assert.equal(
    await processNextAuditExport(db, options(storage)),
    false,
    "a failed job is never claimed again",
  );
  assert.equal(storage.objects.size, 0);
});

test("S3W6 a backed-off job does not block a healthy one, and a lease that keeps expiring is failed at the cap", async () => {
  const stuck = await queuedExport(db, "s3w6a");
  const healthy = await queuedExport(db, "s3w6b");
  const storage = new FaultyStorage();
  storage.failOn = (key) =>
    key.includes(stuck.jobId)
      ? Object.assign(new Error("denied"), {
          name: "AccessDenied",
          $metadata: { httpStatusCode: 403 },
        })
      : null;
  await assert.rejects(processNextAuditExport(db, options(storage)), /denied/);
  assert.equal(
    await processNextAuditExport(db, options(storage)),
    true,
    "healthy job proceeds during the other's backoff",
  );
  assert.equal((await jobRow(healthy.tenantId, healthy.jobId)).state, "ready");
  await adminQuery(
    "UPDATE audit_export_jobs SET state='running', attempts=5, lease_until=now()-interval '1 second', next_attempt_at=NULL WHERE tenant_id=$1 AND job_id=$2",
    [stuck.tenantId, stuck.jobId],
  );
  assert.equal(await processNextAuditExport(db, options(storage)), false);
  const row = await jobRow(stuck.tenantId, stuck.jobId);
  assert.equal(row.state, "failed");
  assert.match(row.last_error ?? "", /maximum number of attempts/);
});
