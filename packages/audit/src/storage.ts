import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import {
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  type S3Client,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

/** Hard ceiling for any presigned download URL. Configuration may only lower it. */
export const MAX_PRESIGN_TTL_SECONDS = 300;
const MIN_PART_BYTES = 5 * 1024 * 1024;
const DEFAULT_PART_BYTES = 8 * 1024 * 1024;
const UUID =
  /^[\da-f]{8}-[\da-f]{4}-[1-8][\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i;
const SAFE_NAME = /^[A-Za-z0-9._-]{1,200}$/;
const KEY =
  /^tenants\/([\da-f-]{36})\/audit-exports\/([\da-f-]{36})\/([a-z.]{1,32})$/;

const INVALID_KEY = "invalid_key";
const CHECKSUM_MISMATCH = "checksum_mismatch";

export type ExportStorageErrorCode =
  | typeof INVALID_KEY
  | "invalid_ttl"
  | "invalid_name"
  | "invalid_config"
  | typeof CHECKSUM_MISMATCH
  | "tenant_mismatch"
  | "encryption_mismatch"
  | "missing"
  | "unsupported";

export class ExportStorageError extends Error {
  constructor(
    readonly code: ExportStorageErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ExportStorageError";
  }
}

export type ExportFormat = "jsonl" | "csv";
export type ExportPart = "export" | "manifest" | "signature";

export interface ExportObject {
  key: string;
  filename: string;
  contentType: string;
}

/** Deterministic object identity: a retry after a crash overwrites the same key. */
export function exportObject(
  tenantId: string,
  jobId: string,
  format: ExportFormat,
  part: ExportPart,
): ExportObject {
  if (!UUID.test(tenantId))
    throw new ExportStorageError(INVALID_KEY, "tenant ID must be a UUID");
  if (!UUID.test(jobId))
    throw new ExportStorageError(INVALID_KEY, "job ID must be a UUID");
  const prefix = `tenants/${tenantId.toLowerCase()}/audit-exports/${jobId.toLowerCase()}`;
  if (part === "manifest")
    return {
      key: `${prefix}/manifest.json`,
      filename: `audit-${jobId}.manifest.json`,
      contentType: "application/json",
    };
  if (part === "signature")
    return {
      key: `${prefix}/signature`,
      filename: `audit-${jobId}.signature`,
      contentType: "text/plain",
    };
  return {
    key: `${prefix}/audit.${format}`,
    filename: `audit-${jobId}.${format}`,
    contentType: format === "csv" ? "text/csv" : "application/x-ndjson",
  };
}

/** Split a key into its tenant, job and file, or refuse anything off-layout. */
export function parseExportKey(key: string) {
  const match = KEY.exec(key);
  if (!match || !UUID.test(match[1]!) || !UUID.test(match[2]!))
    throw new ExportStorageError(
      INVALID_KEY,
      "object key is not an audit export key",
    );
  return { tenantId: match[1]!, jobId: match[2]!, file: match[3]! };
}

export type PutBody = Uint8Array | { path: string };

export interface PutMeta {
  tenantId: string;
  jobId: string;
  contentType: string;
  filename: string;
  /** When set, a body with a different SHA-256 is refused before any upload. */
  expectedSha256?: string;
}

export interface StoredObject {
  key: string;
  size: number;
  /** Hex SHA-256 recorded in object metadata at upload. */
  sha256: string | null;
  /** Hex SHA-256 verified by the store itself; null for multipart composites. */
  checksumSha256: string | null;
  tenantId: string | null;
  jobId: string | null;
  contentType?: string | null;
  encryption?: string | null;
}

export interface PresignOptions {
  filename: string;
  contentType: string;
}

export interface ExportStorage {
  readonly kind: "filesystem" | "s3";
  put(key: string, body: PutBody, meta: PutMeta): Promise<StoredObject>;
  head(key: string): Promise<StoredObject | null>;
  presignGet(
    key: string,
    ttlSeconds: number,
    options: PresignOptions,
  ): Promise<string>;
}

export interface ExpectedObject {
  size?: number;
  sha256?: string;
  tenantId: string;
  jobId: string;
  encryption?: string;
}

/**
 * The single verification used after upload and again before a download URL is
 * issued: bytes, hashes, encryption and, above all, the stored tenant binding.
 */
export function assertStoredMatches(
  stored: StoredObject | null,
  expected: ExpectedObject,
): void {
  if (!stored)
    throw new ExportStorageError("missing", "audit export object is missing");
  if (stored.tenantId !== expected.tenantId || stored.jobId !== expected.jobId)
    throw new ExportStorageError(
      "tenant_mismatch",
      "stored object belongs to another tenant or job",
    );
  const drift =
    (expected.size !== undefined && stored.size !== expected.size) ||
    (expected.sha256 !== undefined && stored.sha256 !== expected.sha256) ||
    (expected.sha256 !== undefined &&
      stored.checksumSha256 != null &&
      stored.checksumSha256 !== expected.sha256);
  if (drift)
    throw new ExportStorageError(
      CHECKSUM_MISMATCH,
      "stored object size or checksum differs",
    );
  if (
    expected.encryption !== undefined &&
    stored.encryption !== expected.encryption
  )
    throw new ExportStorageError(
      "encryption_mismatch",
      "stored object is not encrypted as required",
    );
}

export function attachmentDisposition(filename: string): string {
  if (!SAFE_NAME.test(filename))
    throw new ExportStorageError("invalid_name", "unsafe download file name");
  return `attachment; filename="${filename}"`;
}

export async function digestBody(
  body: PutBody,
): Promise<{ sha256: string; size: number }> {
  const hash = createHash("sha256");
  if (body instanceof Uint8Array)
    return { sha256: hash.update(body).digest("hex"), size: body.byteLength };
  let size = 0;
  for await (const chunk of createReadStream(
    body.path,
  ) as AsyncIterable<Buffer>) {
    hash.update(chunk);
    size += chunk.length;
  }
  return { sha256: hash.digest("hex"), size };
}

export function checkTtl(ttlSeconds: number, ceiling: number): void {
  if (!Number.isInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > ceiling)
    throw new ExportStorageError(
      "invalid_ttl",
      `presign TTL must be an integer from 1 to ${ceiling} seconds`,
    );
}

export interface S3ExportStorageOptions {
  client: S3Client;
  bucket: string;
  /** Customer-managed key; SSE-S3 (AES256) is used when omitted. */
  kmsKeyId?: string;
  presignTtlSeconds?: number;
  partSizeBytes?: number;
}

export class S3ExportStorage implements ExportStorage {
  readonly kind = "s3" as const;
  readonly encryption: "AES256" | "aws:kms";
  readonly maxTtlSeconds: number;
  private readonly partSize: number;

  constructor(private readonly options: S3ExportStorageOptions) {
    this.maxTtlSeconds = options.presignTtlSeconds ?? MAX_PRESIGN_TTL_SECONDS;
    checkTtl(this.maxTtlSeconds, MAX_PRESIGN_TTL_SECONDS);
    this.partSize = options.partSizeBytes ?? DEFAULT_PART_BYTES;
    if (!Number.isInteger(this.partSize) || this.partSize < MIN_PART_BYTES)
      throw new ExportStorageError(
        "invalid_config",
        "multipart part size must be at least 5 MiB",
      );
    this.encryption = options.kmsKeyId ? "aws:kms" : "AES256";
  }

  async put(key: string, body: PutBody, meta: PutMeta): Promise<StoredObject> {
    const parsed = parseExportKey(key);
    if (
      parsed.tenantId !== meta.tenantId.toLowerCase() ||
      parsed.jobId !== meta.jobId.toLowerCase()
    )
      throw new ExportStorageError(
        INVALID_KEY,
        "object key does not belong to this tenant and job",
      );
    const { sha256, size } = await digestBody(body);
    if (meta.expectedSha256 && meta.expectedSha256 !== sha256)
      throw new ExportStorageError(
        CHECKSUM_MISMATCH,
        "body does not match the expected SHA-256",
      );
    const params = {
      Bucket: this.options.bucket,
      Key: key,
      ContentType: meta.contentType,
      ContentDisposition: attachmentDisposition(meta.filename),
      Metadata: { "tenant-id": meta.tenantId, "job-id": meta.jobId, sha256 },
      ServerSideEncryption: this.encryption,
      ...(this.options.kmsKeyId && { SSEKMSKeyId: this.options.kmsKeyId }),
    };
    if (size <= this.partSize) {
      const bytes =
        body instanceof Uint8Array ? body : await readFile(body.path);
      await this.options.client.send(
        new PutObjectCommand({
          ...params,
          Body: bytes,
          ChecksumSHA256: Buffer.from(sha256, "hex").toString("base64"),
        }),
      );
    } else {
      const source =
        body instanceof Uint8Array
          ? Buffer.from(body)
          : createReadStream(body.path);
      await new Upload({
        client: this.options.client,
        params: { ...params, Body: source, ChecksumAlgorithm: "SHA256" },
        partSize: this.partSize,
        queueSize: 4,
        leavePartsOnError: false,
      }).done();
    }
    return {
      key,
      size,
      sha256,
      checksumSha256: null,
      tenantId: meta.tenantId,
      jobId: meta.jobId,
      contentType: meta.contentType,
      encryption: this.encryption,
    };
  }

  async head(key: string): Promise<StoredObject | null> {
    parseExportKey(key);
    let res;
    try {
      res = await this.options.client.send(
        new HeadObjectCommand({
          Bucket: this.options.bucket,
          Key: key,
          ChecksumMode: "ENABLED",
        }),
      );
    } catch (error) {
      const e = error as {
        name?: string;
        $metadata?: { httpStatusCode?: number };
      };
      if (
        e.name === "NotFound" ||
        e.name === "NoSuchKey" ||
        e.$metadata?.httpStatusCode === 404
      )
        return null;
      throw error;
    }
    const meta = res.Metadata ?? {};
    // A multipart object carries a composite "<digest>-<parts>" checksum, not the file hash.
    const checksum =
      res.ChecksumSHA256 && !res.ChecksumSHA256.includes("-")
        ? Buffer.from(res.ChecksumSHA256, "base64").toString("hex")
        : null;
    return {
      key,
      size: res.ContentLength ?? -1,
      sha256: meta.sha256 ?? null,
      checksumSha256: checksum,
      tenantId: meta["tenant-id"] ?? null,
      jobId: meta["job-id"] ?? null,
      contentType: res.ContentType ?? null,
      encryption: res.ServerSideEncryption ?? null,
    };
  }

  /** Every key stored for one tenant and job (operations and tests: proves one object set). */
  async listKeys(tenantId: string, jobId: string): Promise<string[]> {
    const prefix = exportObject(
      tenantId,
      jobId,
      "jsonl",
      "manifest",
    ).key.replace(/manifest\.json$/, "");
    const keys: string[] = [];
    let token: string | undefined;
    do {
      const page = await this.options.client.send(
        new ListObjectsV2Command({
          Bucket: this.options.bucket,
          Prefix: prefix,
          ContinuationToken: token,
        }),
      );
      keys.push(
        ...(page.Contents ?? []).flatMap((object) =>
          object.Key ? [object.Key] : [],
        ),
      );
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
    return keys;
  }

  async presignGet(
    key: string,
    ttlSeconds: number,
    options: PresignOptions,
  ): Promise<string> {
    parseExportKey(key);
    checkTtl(ttlSeconds, this.maxTtlSeconds);
    return getSignedUrl(
      this.options.client,
      new GetObjectCommand({
        Bucket: this.options.bucket,
        Key: key,
        ResponseContentDisposition: attachmentDisposition(options.filename),
        ResponseContentType: options.contentType,
      }),
      { expiresIn: ttlSeconds },
    );
  }
}
