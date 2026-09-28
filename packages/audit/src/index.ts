import {
  createHash,
  createHmac,
  sign,
  verify,
  type KeyObject,
} from "node:crypto";

export type AuditEnvelope = Readonly<{
  auditId: string;
  tenantId: string;
  occurredAt: string;
  actorId: string;
  action: string;
  resourceType: string;
  resourceId: string;
  outcome: string;
  email?: string;
}>;

export type ExportRow = Omit<AuditEnvelope, "email"> & { email?: string };
export type AuditManifest = Readonly<{
  formatVersion: 1;
  fileFormat?: "jsonl" | "csv";
  tenantId: string;
  rowCount: number;
  firstOccurredAt: string | null;
  lastOccurredAt: string | null;
  fileSha256: string;
  rowChainSha256: string;
  publicKeyId: string;
}>;

const hash = (value: string | Uint8Array): string =>
  createHash("sha256").update(value).digest("hex");

export type PseudonymOptions = Readonly<{
  /** Deployment secret, at least 32 bytes (AUDIT_EXPORT_PSEUDONYM_KEY); never per row. */
  masterKey: Uint8Array | string;
  /**
   * Names the key generation in the output (`hmac-sha256:<keyId>:<hex>`). To rotate,
   * deploy the new master key with a new ID: old and new pseudonyms differ, so
   * consumers must not join across generations.
   */
  keyId?: string;
}>;

/** One derived key per tenant: the same address gets unrelated pseudonyms in each tenant. */
export function deriveTenantPseudonymKey(
  masterKey: Uint8Array | string,
  tenantId: string,
): Buffer {
  if (Buffer.byteLength(masterKey) < 32)
    throw new Error("audit pseudonym master key must be at least 32 bytes");
  return createHmac("sha256", masterKey)
    .update(`greenguard/audit-pseudonym/v1/${tenantId}`)
    .digest();
}

function pseudonymize(
  email: string,
  tenantId: string,
  options?: PseudonymOptions,
): string {
  if (!options)
    throw new Error(
      "audit pseudonym key is required to redact email addresses",
    );
  const keyId = options.keyId ?? "v1";
  if (!/^[a-z0-9]{1,16}$/.test(keyId))
    throw new Error(
      "audit pseudonym key ID must be 1-16 lowercase letters or digits",
    );
  const digest = createHmac(
    "sha256",
    deriveTenantPseudonymKey(options.masterKey, tenantId),
  )
    .update(email.trim().toLowerCase())
    .digest("hex");
  return `hmac-sha256:${keyId}:${digest}`;
}

/**
 * Export only allowlisted fields; secrets and arbitrary event payloads stay in owners.
 * A non-privileged view replaces the email with a per-tenant keyed HMAC and fails
 * closed without a key (a bare hash of an email is dictionary-reversible).
 */
export function redactAuditRow(
  row: AuditEnvelope,
  privileged: boolean,
  pseudonym?: PseudonymOptions,
): ExportRow {
  const result: ExportRow = {
    auditId: row.auditId,
    tenantId: row.tenantId,
    occurredAt: row.occurredAt,
    actorId: row.actorId,
    action: row.action,
    resourceType: row.resourceType,
    resourceId: row.resourceId,
    outcome: row.outcome,
  };
  if (row.email) {
    result.email = privileged
      ? row.email
      : pseudonymize(row.email, row.tenantId, pseudonym);
  }
  return result;
}

function canonical(value: unknown): string {
  return JSON.stringify(value);
}

function manifestPayload(manifest: AuditManifest): Buffer {
  // Versioned positional encoding binds exactly the documented manifest fields;
  // JSON object insertion order cannot change signed bytes.
  const fields = [
    manifest.formatVersion,
    manifest.tenantId,
    manifest.rowCount,
    manifest.firstOccurredAt,
    manifest.lastOccurredAt,
    manifest.fileSha256,
    manifest.rowChainSha256,
    manifest.publicKeyId,
  ];
  if (manifest.fileFormat) fields.push(manifest.fileFormat);
  return Buffer.from(canonical(fields), "utf8");
}

export function signAuditManifest(
  manifest: AuditManifest,
  privateKey: KeyObject,
): string {
  if (privateKey.asymmetricKeyType !== "ed25519")
    throw new Error("audit manifest requires Ed25519 key");
  return sign(null, manifestPayload(manifest), privateKey).toString("base64");
}

export function verifyAuditManifest(
  manifest: AuditManifest,
  signature: string,
  publicKey: KeyObject,
): boolean {
  return (
    publicKey.asymmetricKeyType === "ed25519" &&
    manifest.formatVersion === 1 &&
    verify(
      null,
      manifestPayload(manifest),
      publicKey,
      Buffer.from(signature, "base64"),
    )
  );
}

/** The caller has already authenticated and filtered rows by tenant under RLS. */
export function createSignedAuditExport(options: {
  tenantId: string;
  rows: readonly ExportRow[];
  privateKey: KeyObject;
  publicKeyId: string;
}): { file: Buffer; manifest: AuditManifest; signature: string } {
  const { tenantId, rows, privateKey, publicKeyId } = options;
  if (!tenantId || !publicKeyId || privateKey.asymmetricKeyType !== "ed25519") {
    throw new Error("audit export requires tenant, key ID and Ed25519 key");
  }
  let previous = Buffer.alloc(32);
  const lines: string[] = [];
  for (const row of rows) {
    if (row.tenantId !== tenantId)
      throw new Error("cross-tenant audit export row");
    // Structural types do not prevent extra runtime fields. Reapply the allowlist
    // while preserving the caller's already-selected email representation.
    const encoded = canonical(redactAuditRow(row, true));
    lines.push(encoded);
    previous = createHash("sha256")
      .update(previous)
      .update(Buffer.from(encoded, "utf8"))
      .digest();
  }
  const file = Buffer.from(lines.length ? `${lines.join("\n")}\n` : "", "utf8");
  const manifest: AuditManifest = {
    formatVersion: 1,
    tenantId,
    rowCount: rows.length,
    firstOccurredAt: rows[0]?.occurredAt ?? null,
    lastOccurredAt: rows.at(-1)?.occurredAt ?? null,
    fileSha256: hash(file),
    rowChainSha256: previous.toString("hex"),
    publicKeyId,
  };
  return {
    file,
    manifest,
    signature: signAuditManifest(manifest, privateKey),
  };
}

export function verifySignedAuditExport(options: {
  file: Buffer;
  manifest: AuditManifest;
  signature: string;
  publicKey: KeyObject;
}): boolean {
  const { file, manifest, signature, publicKey } = options;
  if (
    hash(file) !== manifest.fileSha256 ||
    !verifyAuditManifest(manifest, signature, publicKey)
  )
    return false;
  const lines = file.length === 0 ? [] : file.toString("utf8").split("\n");
  if (lines.length && lines.pop() !== "") return false;
  if (manifest.fileFormat === "csv") {
    if (lines.shift() !== CSV_HEADER) return false;
  } else if (manifest.fileFormat && manifest.fileFormat !== "jsonl")
    return false;
  if (lines.length !== manifest.rowCount) return false;
  let previous = Buffer.alloc(32);
  try {
    for (const line of lines) {
      const row =
        manifest.fileFormat === "csv"
          ? parseCsvLine(line)
          : (JSON.parse(line) as ExportRow);
      if (row.tenantId !== manifest.tenantId) return false;
      previous = createHash("sha256")
        .update(previous)
        .update(Buffer.from(line, "utf8"))
        .digest();
    }
  } catch {
    return false;
  }
  return previous.toString("hex") === manifest.rowChainSha256;
}

export const CSV_COLUMNS = [
  "auditId",
  "tenantId",
  "occurredAt",
  "actorId",
  "action",
  "resourceType",
  "resourceId",
  "outcome",
  "email",
] as const;
export const CSV_HEADER = CSV_COLUMNS.join(",");
/** A leading `'` stops spreadsheets from evaluating =, +, -, @, tab or CR cells as formulas. */
const neutralizeFormula = (value: string) =>
  /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
export function encodeCsvRow(row: ExportRow): string {
  return CSV_COLUMNS.map((key) => {
    const value = String(row[key] ?? "");
    if (/[\r\n]/.test(value))
      throw new Error("audit CSV field contains a newline");
    return `"${neutralizeFormula(value).replaceAll('"', '""')}"`;
  }).join(",");
}
function parseCsvLine(line: string): ExportRow {
  const values: string[] = [];
  let position = 0;
  while (position < line.length) {
    if (line[position++] !== '"') throw new Error("invalid CSV");
    let value = "";
    let closed = false;
    while (position < line.length) {
      const char = line[position++];
      if (char === '"') {
        if (line[position] === '"') {
          value += '"';
          position++;
        } else {
          closed = true;
          break;
        }
      } else value += char;
    }
    if (!closed || (position < line.length && line[position++] !== ","))
      throw new Error("invalid CSV");
    values.push(value);
  }
  if (values.length !== CSV_COLUMNS.length) throw new Error("invalid CSV");
  return {
    auditId: values[0]!,
    tenantId: values[1]!,
    occurredAt: values[2]!,
    actorId: values[3]!,
    action: values[4]!,
    resourceType: values[5]!,
    resourceId: values[6]!,
    outcome: values[7]!,
    email: values[8] || undefined,
  };
}

export { writeSignedAuditExport } from "./stream.js";
export * from "./storage.js";
export { FilesystemExportStorage } from "./storage-fs.js";
export {
  publishSignedExport,
  isTransientStorageError,
} from "./storage-publish.js";
export {
  readS3StorageConfig,
  createS3ExportStorage,
  type S3StorageConfig,
} from "./storage-config.js";
