import path from "node:path";
import { randomInt } from "node:crypto";
import type { AuditManifest } from "./index.js";
import {
  ExportStorageError,
  assertStoredMatches,
  digestBody,
  exportObject,
  type ExportFormat,
  type ExportPart,
  type ExportStorage,
} from "./storage.js";

const TRANSIENT_NAMES = new Set([
  "RequestTimeout",
  "SlowDown",
  "ThrottlingException",
  "ServiceUnavailable",
  "InternalError",
  "TimeoutError",
  "RequestTimeoutException",
]);
const TRANSIENT_CODES = new Set([
  "ECONNRESET",
  "ETIMEDOUT",
  "ECONNREFUSED",
  "EPIPE",
  "EAI_AGAIN",
]);

/** Retry only what a later attempt can fix: throttling, 5xx, timeouts, network resets. */
export function isTransientStorageError(error: unknown): boolean {
  if (
    error instanceof ExportStorageError ||
    !error ||
    typeof error !== "object"
  )
    return false;
  const e = error as {
    name?: string;
    code?: string;
    $metadata?: { httpStatusCode?: number };
  };
  const status = e.$metadata?.httpStatusCode;
  return (
    (status !== undefined && (status === 429 || status >= 500)) ||
    TRANSIENT_NAMES.has(e.name ?? "") ||
    TRANSIENT_CODES.has(e.code ?? "")
  );
}

export interface RetryOptions {
  attempts?: number;
  baseDelayMs?: number;
}

async function withRetry<T>(
  run: () => Promise<T>,
  retry: RetryOptions,
  sleep: (ms: number) => Promise<unknown>,
): Promise<T> {
  const attempts = retry.attempts ?? 4;
  const base = retry.baseDelayMs ?? 250;
  for (let attempt = 1; ; attempt++) {
    try {
      return await run();
    } catch (error) {
      if (attempt >= attempts || !isTransientStorageError(error)) throw error;
      await sleep(base * 2 ** (attempt - 1) + retryJitter(base));
    }
  }
}

function retryJitter(baseDelayMs: number): number {
  if (baseDelayMs <= 0) return 0;
  return randomInt(Math.ceil(baseDelayMs / 2));
}

export interface PublishOptions {
  storage: ExportStorage;
  tenantId: string;
  jobId: string;
  format: ExportFormat;
  /** Directory produced by `writeSignedAuditExport` (export, manifest, signature). */
  directory: string;
  manifest: AuditManifest;
  retry?: RetryOptions;
  sleep?: (ms: number) => Promise<unknown>;
}

const FILES: Record<ExportPart, (format: ExportFormat) => string> = {
  export: (format) => `audit.${format}`,
  signature: () => "signature",
  manifest: () => "manifest.json",
};

/**
 * Upload the signed export, then its signature, then the manifest (the commit
 * marker), and head-verify every object. Keys are deterministic per job, so a
 * retry after a crash overwrites the same objects. Resolves only when all three
 * objects are stored, bound to this tenant and job, and match the local bytes.
 */
export async function publishSignedExport(
  options: PublishOptions,
): Promise<void> {
  const { storage, tenantId, jobId, format, manifest } = options;
  const sleep =
    options.sleep ??
    ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const retry = options.retry ?? {};
  for (const part of ["export", "signature", "manifest"] as const) {
    const object = exportObject(tenantId, jobId, format, part);
    const body = { path: path.join(options.directory, FILES[part](format)) };
    const local = await digestBody(body);
    if (part === "export" && local.sha256 !== manifest.fileSha256)
      throw new ExportStorageError(
        "checksum_mismatch",
        "export file does not match its signed manifest",
      );
    await withRetry(
      () =>
        storage.put(object.key, body, {
          tenantId,
          jobId,
          contentType: object.contentType,
          filename: object.filename,
          expectedSha256: local.sha256,
        }),
      retry,
      sleep,
    );
    await withRetry(
      async () =>
        assertStoredMatches(await storage.head(object.key), {
          tenantId,
          jobId,
          size: local.size,
          sha256: local.sha256,
        }),
      retry,
      sleep,
    );
  }
}
