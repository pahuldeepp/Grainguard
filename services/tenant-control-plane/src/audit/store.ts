import { randomUUID } from "node:crypto";
import type { AuditEnvelope } from "@greenguard/audit";
import type { Db, Tx } from "../db/client.js";
import { inScope, UUID } from "../db/session.js";
import {
  InvalidInputError,
  NotFoundError,
  RoleForbiddenError,
} from "../domain/errors.js";
import { identityIdOf } from "../domain/ids.js";
import { once, type Actor, type Command } from "../domain/store.js";
import { limit } from "../domain/entitlements.js";
import { RateLimitedError } from "../api/rate-limited.js";
import type { AuditSources } from "./owners.js";

type AuditRecord = {
  audit_id: string;
  occurred_at: string;
  actor_id: string;
  action: string;
  resource_type: string;
  resource_id: string;
  outcome: string;
};
type JobRecord = {
  tenant_id: string;
  job_id: string;
  from_at: Date;
  to_at: Date;
  format: "jsonl" | "csv";
  state: string;
  expires_at: Date;
  file_sha256: string | null;
};

export async function authorizeAudit(tx: Tx, tenantId: string, actor: Actor) {
  const actorId = identityIdOf(actor.issuer, actor.subject);
  const [member] = await tx.$queryRaw<{ role: string }[]>`
    SELECT role FROM memberships WHERE tenant_id=${tenantId}::uuid
    AND identity_id=${actorId}::uuid AND state='active'`;
  if (member?.role !== "admin") throw new RoleForbiddenError();
  const [entitlement] = await tx.$queryRaw<{ enabled: boolean }[]>`
    SELECT COALESCE((features->>'audit_export')::boolean, false) AS enabled
      FROM tenant_entitlements WHERE tenant_id=${tenantId}::uuid`;
  if (!entitlement?.enabled) throw new RoleForbiddenError();
  return actorId;
}

function decodeCursor(
  cursor?: string,
): { at: string; id: string; to: string } | null {
  if (!cursor) return null;
  try {
    const parsed = JSON.parse(
      Buffer.from(cursor, "base64url").toString("utf8"),
    );
    if (
      typeof parsed.at === "string" &&
      !Number.isNaN(Date.parse(parsed.at)) &&
      typeof parsed.to === "string" &&
      !Number.isNaN(Date.parse(parsed.to)) &&
      UUID.test(parsed.id)
    )
      return parsed;
  } catch {
    /* invalid cursors are client errors */
  }
  throw new InvalidInputError("invalid audit cursor");
}
const encodeCursor = (at: string, id: string, to: string) =>
  Buffer.from(JSON.stringify({ at, id, to })).toString("base64url");

async function readRows(
  tx: Tx,
  tenantId: string,
  from: Date,
  to: Date,
  cursor: { at: string; id: string } | null,
  limit: number,
): Promise<AuditEnvelope[]> {
  const rows = await tx.$queryRaw<AuditRecord[]>`
    SELECT audit_id::text,
      to_char(occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS occurred_at,
      actor_identity_id::text AS actor_id,
      action, 'membership'::text AS resource_type,
      COALESCE(identity_id::text, tenant_id::text) AS resource_id,
      'success'::text AS outcome
    FROM membership_events
    WHERE tenant_id=${tenantId}::uuid AND occurred_at >= ${from}
      AND occurred_at < ${to}
      AND (${cursor?.at ?? null}::timestamptz IS NULL OR
           (occurred_at, audit_id) > (${cursor?.at ?? null}::timestamptz, ${cursor?.id ?? null}::uuid))
    UNION ALL
    SELECT audit_id::text,
      to_char(occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
      actor_id::text,
      ('export_' || action)::text, 'audit_export'::text, job_id::text,
      'success'::text
    FROM audit_export_actions
    WHERE tenant_id=${tenantId}::uuid AND occurred_at >= ${from}
      AND occurred_at < ${to}
      AND (${cursor?.at ?? null}::timestamptz IS NULL OR
           (occurred_at, audit_id) > (${cursor?.at ?? null}::timestamptz, ${cursor?.id ?? null}::uuid))
    ORDER BY occurred_at, audit_id LIMIT ${limit}`;
  return rows.map((r) => ({
    auditId: r.audit_id,
    tenantId,
    occurredAt: r.occurred_at,
    actorId: r.actor_id,
    action: r.action,
    resourceType: r.resource_type,
    resourceId: r.resource_id,
    outcome: r.outcome,
  }));
}

async function readAllRows(
  tx: Tx,
  tenantId: string,
  from: Date,
  to: Date,
  cursor: { at: string; id: string } | null,
  limit: number,
  sources?: AuditSources,
) {
  const [control, inventory, billing] = await Promise.all([
    readRows(tx, tenantId, from, to, cursor, limit),
    sources?.read("inventory", tenantId, from, to, cursor, limit) ??
      Promise.resolve([]),
    sources?.read("billing", tenantId, from, to, cursor, limit) ??
      Promise.resolve([]),
  ]);
  return [...control, ...inventory, ...billing]
    .sort(
      (a, b) =>
        a.occurredAt.localeCompare(b.occurredAt) ||
        a.auditId.localeCompare(b.auditId),
    )
    .slice(0, limit);
}

export async function listAuditPage(
  db: Db,
  actor: Actor,
  tenantId: string,
  options: { cursor?: string; limit?: number; from?: string; to?: string },
  sources?: AuditSources,
) {
  const limit = options.limit ?? 100;
  if (!Number.isInteger(limit) || limit < 1 || limit > 500)
    throw new InvalidInputError("audit limit must be 1-500");
  const from = new Date(options.from ?? "1970-01-01T00:00:00.000Z");
  const cursor = decodeCursor(options.cursor);
  const to = new Date(cursor?.to ?? options.to ?? new Date().toISOString());
  if (Number.isNaN(+from) || Number.isNaN(+to) || from >= to)
    throw new InvalidInputError("invalid audit time range");
  return inScope(db, { tenantId }, async (tx) => {
    await authorizeAudit(tx, tenantId, actor);
    const rows = await readAllRows(
      tx,
      tenantId,
      from,
      to,
      cursor,
      limit + 1,
      sources,
    );
    const items = rows.slice(0, limit);
    const last = items.at(-1);
    return {
      items,
      nextCursor:
        rows.length > limit && last
          ? encodeCursor(last.occurredAt, last.auditId, to.toISOString())
          : null,
    };
  });
}

/** The daily export quota (`exports.per_day`) is used up; retry after the UTC day rolls over. */
export class ExportQuotaError extends RateLimitedError {}

// Serialized per tenant so concurrent requests cannot jointly exceed the quota.
async function assertExportQuota(tx: Tx, tenantId: string) {
  const lockKey = `audit-export-quota|${tenantId}`;
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`;
  const { max } = await limit(tx, tenantId, "exports.per_day");
  const [usage] = await tx.$queryRaw<{ n: bigint; retry_after: number }[]>`
    SELECT count(*)::bigint AS n,
      GREATEST(1, CEIL(EXTRACT(EPOCH FROM (date_trunc('day', now() AT TIME ZONE 'UTC') + interval '1 day')
        - (now() AT TIME ZONE 'UTC'))))::int AS retry_after
    FROM audit_export_jobs WHERE tenant_id=${tenantId}::uuid
      AND created_at >= (date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')`;
  if (Number(usage?.n ?? 0n) >= max)
    throw new ExportQuotaError(usage?.retry_after ?? 3600);
}

/**
 * Idempotent per (tenant, Idempotency-Key): a replay returns the stored job and
 * neither counts against the quota nor creates a second job.
 */
export async function requestAuditExport(
  db: Db,
  actor: Actor,
  tenantId: string,
  range: { from: string; to: string; format: "jsonl" | "csv" },
  cmd: Command,
) {
  const from = new Date(range.from),
    to = new Date(range.to);
  if (
    Number.isNaN(+from) ||
    Number.isNaN(+to) ||
    from >= to ||
    to > new Date() ||
    !["jsonl", "csv"].includes(range.format)
  )
    throw new InvalidInputError("invalid audit export range or format");
  return inScope(db, { tenantId }, async (tx) => {
    const actorId = await authorizeAudit(tx, tenantId, actor);
    const request = {
      from: from.toISOString(),
      to: to.toISOString(),
      format: range.format,
    };
    const result = await once(
      tx,
      tenantId,
      "audit.export.request",
      cmd,
      request,
      async () => {
        await assertExportQuota(tx, tenantId);
        const jobId = randomUUID(),
          auditId = randomUUID();
        await tx.$executeRaw`INSERT INTO audit_export_jobs
        (tenant_id, job_id, requester_id, from_at, to_at, format)
        VALUES (${tenantId}::uuid, ${jobId}::uuid, ${actorId}::uuid, ${from}, ${to}, ${range.format})`;
        await tx.$executeRaw`INSERT INTO audit_export_actions
        (tenant_id, audit_id, job_id, actor_id, action)
        VALUES (${tenantId}::uuid, ${auditId}::uuid, ${jobId}::uuid,
                ${actorId}::uuid, 'requested')`;
        return { status: 202, body: { jobId, state: "queued" } };
      },
    );
    return result.body as { jobId: string; state: "queued" };
  });
}

/** Attempts per export before it is parked as `failed` (backoff doubles from 60 s to 1 h). */
export const MAX_EXPORT_ATTEMPTS = 5;

export async function claimAuditJob(db: Db): Promise<JobRecord | null> {
  const candidates = await db.$queryRaw<
    { tenant_id: string; job_id: string }[]
  >`
    SELECT tenant_id::text, job_id::text FROM claim_audit_export_job()`;
  for (const candidate of candidates) {
    const job = await inScope(
      db,
      { tenantId: candidate.tenant_id },
      async (tx) => {
        // A lease that keeps expiring (a crash-looping job) must also reach the cap.
        const exhausted = await tx.$executeRaw`
        UPDATE audit_export_jobs SET state='failed', failed_at=clock_timestamp(),
          lease_until=NULL, next_attempt_at=NULL,
          last_error=left('lease expired after the maximum number of attempts' || COALESCE(': ' || last_error, ''), 500)
        WHERE tenant_id=${candidate.tenant_id}::uuid AND job_id=${candidate.job_id}::uuid
          AND state='running' AND lease_until < now() AND attempts >= ${MAX_EXPORT_ATTEMPTS}`;
        if (exhausted) return undefined;
        const [row] = await tx.$queryRaw<JobRecord[]>`
        UPDATE audit_export_jobs SET state='running',
          lease_until=now() + interval '5 minutes', attempts=attempts+1, next_attempt_at=NULL
        WHERE tenant_id=${candidate.tenant_id}::uuid AND job_id=${candidate.job_id}::uuid
          AND attempts < ${MAX_EXPORT_ATTEMPTS}
          AND ((state='queued' AND (next_attempt_at IS NULL OR next_attempt_at <= now()))
            OR (state='running' AND lease_until < now()))
        RETURNING tenant_id::text, job_id::text, from_at, to_at, format, state, expires_at, file_sha256`;
        return row;
      },
    );
    if (job) return job;
  }
  return null;
}

const reasonOf = (error: unknown) =>
  (error instanceof Error ? `${error.name}: ${error.message}` : "unknown error")
    .replace(/\s+/g, " ")
    .slice(0, 500);

/**
 * Requeue a failed attempt with exponential backoff, or park the job as `failed`
 * once it has used every attempt. The stored reason is bounded and holds only the
 * error name and message (never a URL or credential: presigned URLs are not made here).
 */
export async function recordAuditFailure(
  db: Db,
  job: JobRecord,
  error: unknown,
) {
  await inScope(db, { tenantId: job.tenant_id }, async (tx) => {
    await tx.$executeRaw`UPDATE audit_export_jobs SET
        state = CASE WHEN attempts >= ${MAX_EXPORT_ATTEMPTS} THEN 'failed' ELSE 'queued' END,
        lease_until = NULL,
        next_attempt_at = CASE WHEN attempts >= ${MAX_EXPORT_ATTEMPTS} THEN NULL
          ELSE clock_timestamp() + make_interval(secs => LEAST(30 * power(2, attempts), 3600)) END,
        failed_at = CASE WHEN attempts >= ${MAX_EXPORT_ATTEMPTS} THEN clock_timestamp() END,
        last_error = ${reasonOf(error)}
      WHERE tenant_id=${job.tenant_id}::uuid AND job_id=${job.job_id}::uuid AND state='running'`;
  });
}

export async function* auditJobRows(
  db: Db,
  job: JobRecord,
  sources?: AuditSources,
): AsyncGenerator<AuditEnvelope> {
  let cursor: { at: string; id: string } | null = null;
  for (;;) {
    const current: { at: string; id: string } | null = cursor;
    const rows: AuditEnvelope[] = await inScope(
      db,
      { tenantId: job.tenant_id },
      (tx) =>
        readAllRows(
          tx,
          job.tenant_id,
          job.from_at,
          job.to_at,
          current,
          500,
          sources,
        ),
    );
    if (!rows.length) return;
    for (const row of rows) yield row;
    const last = rows.at(-1)!;
    cursor = { at: last.occurredAt, id: last.auditId };
  }
}

export async function completeAuditJob(db: Db, job: JobRecord, digest: string) {
  await inScope(db, { tenantId: job.tenant_id }, async (tx) => {
    await tx.$executeRaw`UPDATE audit_export_jobs SET state='ready',
      file_sha256=${digest}, completed_at=clock_timestamp(), lease_until=NULL
      WHERE tenant_id=${job.tenant_id}::uuid AND job_id=${job.job_id}::uuid
      AND state='running'`;
  });
}

export async function getAuditJob(
  db: Db,
  actor: Actor,
  tenantId: string,
  jobId: string,
) {
  if (!UUID.test(jobId)) throw new InvalidInputError("invalid export job ID");
  return inScope(db, { tenantId }, async (tx) => {
    await authorizeAudit(tx, tenantId, actor);
    const [job] = await tx.$queryRaw<JobRecord[]>`
      SELECT tenant_id::text, job_id::text, from_at, to_at, format, state, expires_at,
             file_sha256 FROM audit_export_jobs
      WHERE tenant_id=${tenantId}::uuid AND job_id=${jobId}::uuid`;
    if (!job) throw new NotFoundError("audit export");
    return job;
  });
}

export async function auditDownload(
  db: Db,
  actor: Actor,
  tenantId: string,
  jobId: string,
) {
  await inScope(db, { tenantId }, async (tx) => {
    const actorId = await authorizeAudit(tx, tenantId, actor);
    const auditId = randomUUID();
    await tx.$executeRaw`INSERT INTO audit_export_actions
      (tenant_id,audit_id,job_id,actor_id,action) VALUES
      (${tenantId}::uuid,${auditId}::uuid,${jobId}::uuid,${actorId}::uuid,'downloaded')`;
  });
}
