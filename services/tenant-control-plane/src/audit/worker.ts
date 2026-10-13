import { createPrivateKey, createPublicKey, type KeyObject } from "node:crypto";
import { createServer, type Server } from "node:http";
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
  renewAuditLease,
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
  /** Test hook for lease renewal timing. */
  heartbeatIntervalMs?: number;
}

export function auditWorkerIdentityFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): {
  privateKey: KeyObject;
  publicKeyId: string;
} {
  const privatePem = env.AUDIT_EXPORT_PRIVATE_KEY_PEM?.replaceAll("\\n", "\n");
  const publicPem = env.AUDIT_EXPORT_PUBLIC_KEY_PEM?.replaceAll("\\n", "\n");
  const publicKeyId = env.AUDIT_EXPORT_PUBLIC_KEY_ID;
  if (
    !privatePem ||
    !publicPem ||
    !publicKeyId ||
    !/^[a-zA-Z0-9._-]{1,64}$/.test(publicKeyId)
  )
    throw new Error("audit worker signing identity is incomplete");
  let privateKey: KeyObject;
  let publicKey: KeyObject;
  try {
    privateKey = createPrivateKey(privatePem);
    publicKey = createPublicKey(publicPem);
  } catch {
    throw new Error("audit worker signing identity is invalid");
  }
  if (
    privateKey.asymmetricKeyType !== "ed25519" ||
    publicKey.asymmetricKeyType !== "ed25519" ||
    !createPublicKey(privateKey)
      .export({ type: "spki", format: "der" })
      .equals(publicKey.export({ type: "spki", format: "der" }))
  )
    throw new Error("audit worker signing key pair does not match");
  return { privateKey, publicKeyId };
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
  // Keep long exports claimed. The attempt number fences stale workers after takeover.
  let leaseError: unknown;
  let heartbeat: Promise<void> = Promise.resolve();
  const timer = setInterval(() => {
    heartbeat = heartbeat
      .then(() => renewAuditLease(db, job))
      .catch((error: unknown) => {
        leaseError = error;
      });
  }, options.heartbeatIntervalMs ?? 60_000);
  timer.unref();
  const assertClaim = async () => {
    await heartbeat;
    if (leaseError) throw leaseError;
    await renewAuditLease(db, job);
  };
  let scratch: string | undefined;
  try {
    scratch = await mkdtemp(
      path.join(
        options.workDirectory ?? os.tmpdir(),
        `gg-audit-${job.job_id}-`,
      ),
    );
    const built = await writeSignedAuditExport({
      tenantId: job.tenant_id,
      jobId: job.job_id,
      rows: auditJobRows(db, job, options.sources),
      destinationDirectory: scratch,
      privateKey: options.privateKey,
      publicKeyId: options.publicKeyId,
      format: job.format,
    });
    await assertClaim();
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
    await assertClaim();
    await completeAuditJob(db, job, built.manifest.fileSha256);
    return true;
  } catch (error) {
    // Requeue with backoff (or fail at the attempt cap) so a bad job cannot crash-loop.
    await recordAuditFailure(db, job, error).catch(() => undefined);
    throw error;
  } finally {
    clearInterval(timer);
    await heartbeat;
    if (scratch) await rm(scratch, { recursive: true, force: true });
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

export function createAuditWorkerHealthServer(isReady: () => boolean): Server {
  return createServer((request, response) => {
    if (
      request.method !== "GET" ||
      !["/healthz", "/readyz"].includes(request.url ?? "")
    ) {
      response.writeHead(404).end();
      return;
    }
    const ready = request.url === "/healthz" || isReady();
    response.writeHead(ready ? 200 : 503, { "content-type": "text/plain" });
    response.end(ready ? "ok" : "not ready");
  });
}

if (
  process.argv[1] &&
  import.meta.url === new URL(`file://${process.argv[1]}`).href
) {
  const url = process.env.CONTROL_AUDIT_DATABASE_URL;
  const billingUrl = process.env.BILLING_AUDIT_DATABASE_URL;
  const registryFile = process.env.INVENTORY_AUDIT_SHARD_REGISTRY_FILE;
  if (!url || !billingUrl || !registryFile)
    throw new Error(
      "audit worker requires dedicated control/billing URLs and an inventory shard registry",
    );
  const { privateKey, publicKeyId } = auditWorkerIdentityFromEnv(process.env);
  const backend = workerStorageFromEnv(process.env);
  const sources = new AuditSources("", billingUrl, process.env, {
    registryFileEnv: "INVENTORY_AUDIT_SHARD_REGISTRY_FILE",
    service: "audit-export-worker",
    roles: ["inventory_audit_reader"],
  });
  const db = createDb(url);
  let ready = false;
  let stopping = false;
  const health = createAuditWorkerHealthServer(() => ready && !stopping);
  const healthPort = Number(process.env.AUDIT_EXPORT_HEALTH_PORT ?? "8098");
  if (!Number.isInteger(healthPort) || healthPort < 1 || healthPort > 65535)
    throw new Error("AUDIT_EXPORT_HEALTH_PORT must be a valid TCP port");
  await db.$queryRaw`SELECT 1`;
  await sources.healthcheck();
  await new Promise<void>((resolve, reject) => {
    health.once("error", reject);
    health.listen(healthPort, "0.0.0.0", () => {
      health.off("error", reject);
      resolve();
    });
  });
  ready = true;
  process.once("SIGTERM", () => {
    stopping = true;
    ready = false;
  });
  process.once("SIGINT", () => {
    stopping = true;
    ready = false;
  });
  const run = async () => {
    try {
      while (!stopping) {
        const didWork = await processNextAuditExport(db, {
          ...backend,
          privateKey,
          publicKeyId,
          sources,
        })
          .then((worked) => {
            ready = true;
            return worked;
          })
          .catch((error: unknown) => {
            ready = false;
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
      await new Promise<void>((resolve) => health.close(() => resolve()));
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
