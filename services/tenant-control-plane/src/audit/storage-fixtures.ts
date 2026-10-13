import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  type ExportStorage,
  type PutBody,
  type PutMeta,
  type StoredObject,
} from "@greenguard/audit";
import { seedPlan } from "../testing/entitlements.js";
import {
  adminQuery,
  createActiveTenantFixture,
  runtimeDb,
} from "../testing/fixtures.js";
import { type Actor } from "../domain/store.js";
import { requestAuditExport } from "./store.js";

export const command = () => ({
  idempotencyKey: randomUUID(),
  correlationId: randomUUID(),
  traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
});

/** A tenant with an admin and the audit_export feature; `exportsPerDay` is its daily quota. */
export async function seedOrg(
  db: ReturnType<typeof runtimeDb>,
  label: string,
  exportsPerDay = 50,
) {
  const admin: Actor = {
    issuer: "https://issuer.test",
    subject: `${label}-${randomUUID()}`,
  };
  const created = await createActiveTenantFixture(db, admin, label, command());
  const tenantId = created.body.tenantId as string;
  await seedPlan(
    tenantId,
    { "exports.per_day": exportsPerDay },
    { audit_export: true },
  );
  return { admin, tenantId };
}

export const wholeRange = () => ({
  from: "2020-01-01T00:00:00Z",
  to: new Date().toISOString(),
});

/** A seeded tenant with one queued export. */
export async function queuedExport(
  db: ReturnType<typeof runtimeDb>,
  label: string,
  format: "jsonl" | "csv" = "jsonl",
) {
  const org = await seedOrg(db, label);
  const job = await requestAuditExport(
    db,
    org.admin,
    org.tenantId,
    { ...wholeRange(), format },
    command(),
  );
  return { ...org, jobId: job.jobId };
}

export const expireLease = (tenantId: string, jobId: string) =>
  adminQuery(
    "UPDATE audit_export_jobs SET lease_until=now()-interval '1 second' WHERE tenant_id=$1 AND job_id=$2",
    [tenantId, jobId],
  );

/** Park a queued job so it cannot be claimed by another test's worker. */
export const settleJob = (tenantId: string, jobId: string) =>
  adminQuery(
    "UPDATE audit_export_jobs SET state='ready', lease_until=NULL WHERE tenant_id=$1 AND job_id=$2",
    [tenantId, jobId],
  );

export const jobRow = async (tenantId: string, jobId: string) =>
  (
    await adminQuery<{
      state: string;
      attempts: number;
      last_error: string | null;
      next_attempt_at: Date | null;
      failed_at: Date | null;
    }>(
      "SELECT state, attempts, last_error, next_attempt_at, failed_at FROM audit_export_jobs WHERE tenant_id=$1 AND job_id=$2",
      [tenantId, jobId],
    )
  )[0]!;

/** Skip the retry backoff so the next poll may claim the job. */
export const skipBackoff = (tenantId: string, jobId: string) =>
  adminQuery(
    "UPDATE audit_export_jobs SET next_attempt_at=now()-interval '1 second' WHERE tenant_id=$1 AND job_id=$2",
    [tenantId, jobId],
  );

/** In-memory ExportStorage that can fail on chosen operations, for worker fault tests. */
export class FaultyStorage implements ExportStorage {
  readonly kind = "s3" as const;
  readonly objects = new Map<string, { bytes: Buffer; meta: PutMeta }>();
  failOn: ((key: string, attempt: number) => Error | null) | null = null;
  tamper: ((stored: StoredObject) => StoredObject) | null = null;
  private attempts = 0;

  async put(key: string, body: PutBody, meta: PutMeta): Promise<StoredObject> {
    const failure = this.failOn?.(key, ++this.attempts);
    if (failure) throw failure;
    const bytes =
      body instanceof Uint8Array
        ? Buffer.from(body)
        : await readFile(body.path);
    this.objects.set(key, { bytes, meta });
    return this.describe(key)!;
  }
  async head(key: string) {
    this.heads.push(key);
    const stored = this.describe(key);
    return stored && this.tamper ? this.tamper(stored) : stored;
  }
  readonly presigned: { key: string; ttl: number }[] = [];
  readonly heads: string[] = [];
  async presignGet(key: string, ttl: number): Promise<string> {
    this.presigned.push({ key, ttl });
    return `https://objects.invalid/${key}?ttl=${ttl}`;
  }
  private describe(key: string): StoredObject | null {
    const hit = this.objects.get(key);
    if (!hit) return null;
    const sha256 = createHash("sha256").update(hit.bytes).digest("hex");
    return {
      key,
      size: hit.bytes.length,
      sha256,
      checksumSha256: sha256,
      tenantId: hit.meta.tenantId,
      jobId: hit.meta.jobId,
      encryption: "AES256",
    };
  }
}
