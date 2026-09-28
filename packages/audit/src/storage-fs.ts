import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import {
  ExportStorageError,
  digestBody,
  parseExportKey,
  type ExportStorage,
  type PutBody,
  type PutMeta,
  type StoredObject,
} from "./storage.js";

type Sidecar = {
  tenantId: string;
  jobId: string;
  sha256: string;
  contentType: string;
};

/**
 * Local/dev backend. Objects live at `<root>/<jobId>/<file>` (the layout the HMAC
 * download route already serves) with a private sidecar recording tenant and
 * hash. Each file lands by write-to-temp then rename, so a crash never exposes a
 * partial object and a retry overwrites it. It cannot presign: downloads stay on
 * the authenticated API route.
 */
export class FilesystemExportStorage implements ExportStorage {
  readonly kind = "filesystem" as const;

  constructor(private readonly root: string) {}

  private locate(key: string) {
    const parsed = parseExportKey(key);
    const directory = path.join(this.root, parsed.jobId);
    return {
      ...parsed,
      directory,
      file: path.join(directory, parsed.file),
      sidecar: path.join(directory, `.${parsed.file}.meta.json`),
    };
  }

  async put(key: string, body: PutBody, meta: PutMeta): Promise<StoredObject> {
    const target = this.locate(key);
    if (
      target.tenantId !== meta.tenantId.toLowerCase() ||
      target.jobId !== meta.jobId.toLowerCase()
    )
      throw new ExportStorageError(
        "invalid_key",
        "object key does not belong to this tenant and job",
      );
    const { sha256, size } = await digestBody(body);
    if (meta.expectedSha256 && meta.expectedSha256 !== sha256)
      throw new ExportStorageError(
        "checksum_mismatch",
        "body does not match the expected SHA-256",
      );
    await mkdir(target.directory, { recursive: true, mode: 0o700 });
    const temp = `${target.file}.tmp-${randomUUID()}`;
    try {
      if (body instanceof Uint8Array)
        await writeFile(temp, body, { mode: 0o600 });
      else
        await pipeline(
          createReadStream(body.path),
          createWriteStream(temp, { mode: 0o600 }),
        );
      await rename(temp, target.file);
    } finally {
      await rm(temp, { force: true });
    }
    const sidecar: Sidecar = {
      tenantId: meta.tenantId,
      jobId: meta.jobId,
      sha256,
      contentType: meta.contentType,
    };
    const sidecarTemp = `${target.sidecar}.tmp-${randomUUID()}`;
    try {
      await writeFile(sidecarTemp, JSON.stringify(sidecar), { mode: 0o600 });
      await rename(sidecarTemp, target.sidecar);
    } finally {
      await rm(sidecarTemp, { force: true });
    }
    return {
      key,
      size,
      sha256,
      checksumSha256: sha256,
      tenantId: meta.tenantId,
      jobId: meta.jobId,
      contentType: meta.contentType,
      encryption: null,
    };
  }

  async head(key: string): Promise<StoredObject | null> {
    const target = this.locate(key);
    let size: number;
    try {
      size = (await stat(target.file)).size;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(
      target.file,
    ) as AsyncIterable<Buffer>)
      hash.update(chunk);
    let sidecar: Sidecar | null = null;
    try {
      sidecar = JSON.parse(await readFile(target.sidecar, "utf8")) as Sidecar;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return {
      key,
      size,
      sha256: sidecar?.sha256 ?? null,
      checksumSha256: hash.digest("hex"),
      tenantId: sidecar?.tenantId ?? null,
      jobId: sidecar?.jobId ?? null,
      contentType: sidecar?.contentType ?? null,
      encryption: null,
    };
  }

  presignGet(): Promise<string> {
    return Promise.reject(
      new ExportStorageError(
        "unsupported",
        "filesystem storage cannot presign; use the authenticated download route",
      ),
    );
  }
}
