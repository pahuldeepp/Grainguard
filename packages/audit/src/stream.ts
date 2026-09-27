import {
  createHash,
  createPublicKey,
  randomUUID,
  type KeyObject,
} from "node:crypto";
import { createReadStream } from "node:fs";
import {
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import {
  CSV_HEADER,
  encodeCsvRow,
  redactAuditRow,
  signAuditManifest,
  verifyAuditManifest,
  type AuditManifest,
  type ExportRow,
} from "./index.js";

/**
 * Stream a tenant-filtered, keyset-ordered audit result to a private staging
 * directory, then publish data, manifest and signature with one directory rename.
 * The caller owns its database job lease and row-level security transaction.
 */
export async function writeSignedAuditExport(options: {
  tenantId: string;
  rows: AsyncIterable<ExportRow>;
  destinationDirectory: string;
  jobId: string;
  privateKey: KeyObject;
  publicKeyId: string;
  format?: "jsonl" | "csv";
}): Promise<{ directory: string; manifest: AuditManifest; signature: string }> {
  const {
    tenantId,
    rows,
    destinationDirectory,
    jobId,
    privateKey,
    publicKeyId,
    format = "jsonl",
  } = options;
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(jobId)) throw new Error("invalid job ID");
  if (!tenantId || !publicKeyId || privateKey.asymmetricKeyType !== "ed25519")
    throw new Error("audit export requires tenant, key ID and Ed25519 key");
  await mkdir(destinationDirectory, { recursive: true, mode: 0o700 });
  const staging = path.join(
    destinationDirectory,
    `.tmp-${jobId}-${randomUUID()}`,
  );
  const completed = path.join(destinationDirectory, jobId);
  const prior = await readCompletedExport({
    directory: completed,
    tenantId,
    publicKeyId,
    privateKey,
    format,
  });
  if (prior) return prior;
  await mkdir(staging, { mode: 0o700 });
  const fileHash = createHash("sha256");
  let writtenManifest: AuditManifest | undefined;
  try {
    const handle = await open(
      path.join(staging, format === "csv" ? "audit.csv" : "audit.jsonl"),
      "wx",
      0o600,
    );
    let rowsSummary: RowSummary;
    try {
      rowsSummary = await writeAuditRows({
        rows,
        tenantId,
        handle,
        fileHash,
        format,
      });
      await handle.sync();
    } finally {
      await handle.close();
    }
    const manifest: AuditManifest = {
      formatVersion: 1,
      ...(format === "csv" && { fileFormat: "csv" as const }),
      tenantId,
      rowCount: rowsSummary.count,
      firstOccurredAt: rowsSummary.first,
      lastOccurredAt: rowsSummary.last,
      fileSha256: fileHash.digest("hex"),
      rowChainSha256: rowsSummary.chain.toString("hex"),
      publicKeyId,
    };
    writtenManifest = manifest;
    const signature = signAuditManifest(manifest, privateKey);
    await writeFile(
      path.join(staging, "manifest.json"),
      JSON.stringify(manifest),
      {
        flag: "wx",
        mode: 0o600,
      },
    );
    await writeFile(path.join(staging, "signature"), signature, {
      flag: "wx",
      mode: 0o600,
    });
    await rename(staging, completed);
    return { directory: completed, manifest, signature };
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    // Another worker may have published the same leased job concurrently. Reuse
    // only a valid, byte-identical result; never replace a completed export.
    if (writtenManifest) {
      const winner = await readCompletedExport({
        directory: completed,
        tenantId,
        publicKeyId,
        privateKey,
        format,
      });
      if (winner?.manifest.fileSha256 === writtenManifest.fileSha256)
        return winner;
    }
    throw error;
  }
}

type RowSummary = {
  count: number;
  first: string | null;
  last: string | null;
  chain: Buffer;
};

async function writeAuditRows(options: {
  rows: AsyncIterable<ExportRow>;
  tenantId: string;
  handle: Awaited<ReturnType<typeof open>>;
  fileHash: ReturnType<typeof createHash>;
  format: "jsonl" | "csv";
}): Promise<RowSummary> {
  const { rows, tenantId, handle, fileHash, format } = options;
  if (format === "csv") {
    const header = Buffer.from(`${CSV_HEADER}\n`, "utf8");
    await handle.writeFile(header);
    fileHash.update(header);
  }

  let chain = Buffer.alloc(32);
  let count = 0;
  let first: string | null = null;
  let last: string | null = null;
  let previousKey = "";
  for await (const row of rows) {
    if (row.tenantId !== tenantId)
      throw new Error("cross-tenant audit export row");
    const key = `${row.occurredAt}\0${row.auditId}`;
    if (previousKey && key <= previousKey)
      throw new Error("audit rows must be in keyset order");
    previousKey = key;
    const clean = redactAuditRow(row, true);
    const line = format === "csv" ? encodeCsvRow(clean) : JSON.stringify(clean);
    const bytes = Buffer.from(`${line}\n`, "utf8");
    await handle.writeFile(bytes);
    fileHash.update(bytes);
    chain = createHash("sha256")
      .update(chain)
      .update(Buffer.from(line, "utf8"))
      .digest();
    first ??= row.occurredAt;
    last = row.occurredAt;
    count++;
  }
  return { count, first, last, chain };
}

async function readCompletedExport(options: {
  directory: string;
  tenantId: string;
  publicKeyId: string;
  privateKey: KeyObject;
  format: "jsonl" | "csv";
}): Promise<{
  directory: string;
  manifest: AuditManifest;
  signature: string;
} | null> {
  const { directory, tenantId, publicKeyId, privateKey, format } = options;
  try {
    await stat(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const manifest = JSON.parse(
    await readFile(path.join(directory, "manifest.json"), "utf8"),
  ) as AuditManifest;
  const signature = await readFile(path.join(directory, "signature"), "utf8");
  const expectedFileFormat = format === "csv" ? "csv" : undefined;
  if (
    manifest.tenantId !== tenantId ||
    manifest.publicKeyId !== publicKeyId ||
    manifest.fileFormat !== expectedFileFormat ||
    !verifyAuditManifest(manifest, signature, createPublicKey(privateKey))
  )
    throw new Error("existing audit export has invalid identity or signature");

  const fileName = format === "csv" ? "audit.csv" : "audit.jsonl";
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(path.join(directory, fileName)))
    digest.update(chunk);
  if (digest.digest("hex") !== manifest.fileSha256)
    throw new Error("existing audit export file is corrupted");
  return { directory, manifest, signature };
}
