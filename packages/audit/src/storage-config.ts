import { S3Client } from "@aws-sdk/client-s3";
import { MAX_PRESIGN_TTL_SECONDS, S3ExportStorage } from "./storage.js";

export interface S3StorageConfig {
  bucket: string;
  region: string;
  endpoint?: string;
  forcePathStyle: boolean;
  credentials?: { accessKeyId: string; secretAccessKey: string };
  kmsKeyId?: string;
  presignTtlSeconds: number;
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);
const NAMES = [
  "BUCKET",
  "REGION",
  "ENDPOINT",
  "FORCE_PATH_STYLE",
  "ACCESS_KEY_ID",
  "SECRET_ACCESS_KEY",
  "KMS_KEY_ID",
  "PRESIGN_TTL_SECONDS",
] as const;
const v = (name: string) => `AUDIT_EXPORT_S3_${name}`;
const VAR = Object.fromEntries(NAMES.map((name) => [name, v(name)])) as Record<
  (typeof NAMES)[number],
  string
>;

function readEndpoint(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${VAR.ENDPOINT} must be a valid URL`);
  }
  if (
    url.protocol !== "https:" &&
    !(url.protocol === "http:" && LOOPBACK.has(url.hostname))
  )
    throw new Error(
      `${VAR.ENDPOINT} must use https unless it is a loopback address`,
    );
  return raw;
}

function readTtl(raw: string | undefined): number {
  if (raw === undefined || raw === "") return MAX_PRESIGN_TTL_SECONDS;
  const ttl = Number(raw);
  if (!/^\d+$/.test(raw) || ttl < 1 || ttl > MAX_PRESIGN_TTL_SECONDS)
    throw new Error(
      `${VAR.PRESIGN_TTL_SECONDS} must be an integer from 1 to ${MAX_PRESIGN_TTL_SECONDS}`,
    );
  return ttl;
}

/**
 * S3 is selected when the bucket variable is set; nothing set selects the
 * filesystem backend (null). Any other partial combination throws (fail closed).
 * Credentials come from the AWS provider chain unless both static values are set.
 */
export function readS3StorageConfig(
  env: NodeJS.ProcessEnv,
): S3StorageConfig | null {
  const anySet = NAMES.some((name) => Boolean(env[v(name)]));
  if (!anySet) return null;
  const bucket = env[VAR.BUCKET];
  if (!bucket)
    throw new Error(
      `${VAR.BUCKET} is required when any AUDIT_EXPORT_S3_* setting is set`,
    );
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket))
    throw new Error(`${VAR.BUCKET} is not a valid bucket name`);
  const region = env[VAR.REGION];
  if (!region) throw new Error(`${VAR.REGION} is required with ${VAR.BUCKET}`);
  const accessKeyId = env[VAR.ACCESS_KEY_ID];
  const secretAccessKey = env[VAR.SECRET_ACCESS_KEY];
  if (Boolean(accessKeyId) !== Boolean(secretAccessKey))
    throw new Error(
      `${VAR.ACCESS_KEY_ID} and ${VAR.SECRET_ACCESS_KEY} must be set together`,
    );
  const endpoint = env[VAR.ENDPOINT]
    ? readEndpoint(env[VAR.ENDPOINT]!)
    : undefined;
  const style = env[VAR.FORCE_PATH_STYLE];
  if (style && style !== "true" && style !== "false")
    throw new Error(`${VAR.FORCE_PATH_STYLE} must be true or false`);
  return {
    bucket,
    region,
    ...(endpoint && { endpoint }),
    forcePathStyle: style ? style === "true" : Boolean(endpoint),
    ...(accessKeyId &&
      secretAccessKey && { credentials: { accessKeyId, secretAccessKey } }),
    ...(env[VAR.KMS_KEY_ID] && { kmsKeyId: env[VAR.KMS_KEY_ID] }),
    presignTtlSeconds: readTtl(env[VAR.PRESIGN_TTL_SECONDS]),
  };
}

export function createS3ExportStorage(
  config: S3StorageConfig,
  options: { partSizeBytes?: number } = {},
) {
  return new S3ExportStorage({
    client: new S3Client({
      region: config.region,
      ...(config.endpoint && { endpoint: config.endpoint }),
      forcePathStyle: config.forcePathStyle,
      ...(config.credentials && { credentials: config.credentials }),
    }),
    bucket: config.bucket,
    kmsKeyId: config.kmsKeyId,
    presignTtlSeconds: config.presignTtlSeconds,
    partSizeBytes: options.partSizeBytes,
  });
}
