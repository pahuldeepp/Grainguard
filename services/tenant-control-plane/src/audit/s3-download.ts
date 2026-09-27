import {
  ExportStorageError,
  MAX_PRESIGN_TTL_SECONDS,
  assertStoredMatches,
  exportObject,
  type ExportFormat,
  type ExportStorage,
} from "@greenguard/audit";
import { NotFoundError } from "../domain/errors.js";

export interface DownloadJob {
  tenant_id: string;
  job_id: string;
  format: ExportFormat;
  file_sha256: string | null;
  expires_at: Date;
}

export interface ExportLinks {
  url: string;
  expiresAt: string;
  sha256: string;
  manifestUrl: string;
  signatureUrl: string;
}

/**
 * Presign short-lived GET URLs for one export. Call only AFTER the caller has been
 * authorized for this tenant and job. Re-checks that the stored objects carry the
 * same tenant and job in their own metadata and the recorded digest, so a key that
 * points at another tenant's object is never signed. Every failure is "not found".
 * The returned URLs are bearer credentials: callers must never log them.
 */
export async function issueExportLinks(
  storage: ExportStorage,
  job: DownloadJob,
  configuredTtlSeconds: number,
  now = Date.now(),
): Promise<ExportLinks> {
  const lifetime = Math.floor((job.expires_at.getTime() - now) / 1000);
  const ttl = Math.min(configuredTtlSeconds, MAX_PRESIGN_TTL_SECONDS, lifetime);
  if (!job.file_sha256 || ttl < 1) throw new NotFoundError("audit export");
  const parts = (["export", "manifest", "signature"] as const).map((part) =>
    exportObject(job.tenant_id, job.job_id, job.format, part),
  );
  try {
    for (const object of parts) {
      const digest = object === parts[0] ? { sha256: job.file_sha256 } : {};
      assertStoredMatches(await storage.head(object.key), {
        tenantId: job.tenant_id,
        jobId: job.job_id,
        ...digest,
      });
    }
    const [url, manifestUrl, signatureUrl] = await Promise.all(
      parts.map((object) => storage.presignGet(object.key, ttl, object)),
    );
    return {
      url: url!,
      expiresAt: new Date(now + ttl * 1000).toISOString(),
      sha256: job.file_sha256,
      manifestUrl: manifestUrl!,
      signatureUrl: signatureUrl!,
    };
  } catch (error) {
    if (error instanceof ExportStorageError)
      throw new NotFoundError("audit export");
    throw error;
  }
}
