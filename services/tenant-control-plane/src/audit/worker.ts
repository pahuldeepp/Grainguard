import { createPrivateKey, type KeyObject } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  FilesystemExportStorage,
  createS3ExportStorage,
  publishSignedExport,
  readS3StorageConfig,
  writeSignedAuditExport,
  type ExportStorage,
} from "@greenguard/audit";
import type { Db } from "../db/client.js";
import { createDb } from "../db/client.js";
import {
  auditJobRows,
  claimAuditJob,
  completeAuditJob,
  recordAuditFailure,
} from "./store.js";
import { AuditSources } from "./owners.js";

export interface AuditWorkerOptions {
  /** Local/dev backend: the directory the HMAC download route serves. */
  destinationDirectory?: string;
  /** Object store (S3-compatible in production); takes precedence over the directory. */
  storage?: ExportStorage;
  privateKey: KeyObject;
  publicKeyId: string;
  sources?: AuditSources;
  /** Parent of the per-job scratch directory; defaults to the OS temp directory. */
  workDirectory?: string;
  retry?: { attempts?: number; baseDelayMs?: number };
  sleep?: (ms: number) => Promise<unknown>;
}

function backendOf(options: AuditWorkerOptions): ExportStorage {
  if (options.storage) return options.storage;
  if (!options.destinationDirectory)
    throw new Error(
      "audit worker requires an export storage or a destination directory",
    );
  return new FilesystemExportStorage(options.destinationDirectory);
}

/**
 * Claim one job, build the signed export in private scratch space, publish it to
 * the storage backend under deterministic keys, and only then mark the job ready.
 * Any failure leaves the job leased and reclaimable; retries overwrite the same
 * keys. Scratch space is always removed.
 */
export async function processNextAuditExport(
  db: Db,
  options: AuditWorkerOptions,
) {
  const storage = backendOf(options);
  const job = await claimAuditJob(db);
  if (!job) return false;
  const scratch = await mkdtemp(
    path.join(options.workDirectory ?? os.tmpdir(), `gg-audit-${job.job_id}-`),
  );
  try {
    const built = await writeSignedAuditExport({
      tenantId: job.tenant_id,
      jobId: job.job_id,
      rows: auditJobRows(db, job, options.sources),
      destinationDirectory: scratch,
      privateKey: options.privateKey,
      publicKeyId: options.publicKeyId,
      format: job.format,
    });
    await publishSignedExport({
      storage,
      tenantId: job.tenant_id,
      jobId: job.job_id,
      format: job.format,
      directory: built.directory,
      manifest: built.manifest,
      retry: options.retry,
      sleep: options.sleep,
    });
    await completeAuditJob(db, job, built.manifest.fileSha256);
    return true;
  } catch (error) {
    // Requeue with backoff (or fail at the attempt cap) so a bad job cannot crash-loop.
    await recordAuditFailure(db, job, error).catch(() => undefined);
    throw error;
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

/** S3 when AUDIT_EXPORT_S3_BUCKET is set, otherwise the local directory; never neither. */
export function workerStorageFromEnv(
  env: NodeJS.ProcessEnv,
): { storage: ExportStorage } | { destinationDirectory: string } {
  const s3 = readS3StorageConfig(env);
  if (s3) return { storage: createS3ExportStorage(s3) };
  if (!env.AUDIT_EXPORT_DIRECTORY)
    throw new Error(
      "audit worker requires AUDIT_EXPORT_S3_BUCKET or AUDIT_EXPORT_DIRECTORY",
    );
  return { destinationDirectory: env.AUDIT_EXPORT_DIRECTORY };
}

if (
  process.argv[1] &&
  import.meta.url === new URL(`file://${process.argv[1]}`).href
) {
  const url = process.env.CONTROL_DATABASE_URL;
  const pem = process.env.AUDIT_EXPORT_PRIVATE_KEY_PEM;
  const publicKeyId = process.env.AUDIT_EXPORT_PUBLIC_KEY_ID;
  const inventoryUrl = process.env.INVENTORY_DATABASE_URL;
  const billingUrl = process.env.BILLING_DATABASE_URL;
  if (!url || !pem || !publicKeyId || !inventoryUrl || !billingUrl)
    throw new Error(
      "audit worker requires database URL, Ed25519 key and key ID",
    );
  const backend = workerStorageFromEnv(process.env);
  const db = createDb(url);
  const sources = new AuditSources(inventoryUrl, billingUrl);
  const key = createPrivateKey(pem.replaceAll(String.raw`\n`, "\n"));
  let stopping = false;
  process.once("SIGTERM", () => {
    stopping = true;
  });
  process.once("SIGINT", () => {
    stopping = true;
  });
  const run = async () => {
    try {
      while (!stopping) {
        const didWork = await processNextAuditExport(db, {
          ...backend,
          privateKey: key,
          publicKeyId,
          sources,
        }).catch((error: unknown) => {
          // The job stays leased and is reclaimed after its lease expires.
          console.error(
            "audit export attempt failed",
            error instanceof Error ? error.message : error,
          );
          return false;
        });
        if (!didWork && !stopping)
          await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    } finally {
      await db.$disconnect();
      await sources.close();
    }
  };
  try {
    await run();
  } catch (error: unknown) {
    console.error("audit export worker failed", error);
    process.exitCode = 1;
  }
}
