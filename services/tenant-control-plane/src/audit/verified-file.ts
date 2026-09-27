import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import type { ServerResponse } from "node:http";
import { pipeline, type Readable } from "node:stream";
import { NotFoundError } from "../domain/errors.js";

const notFound = () => new NotFoundError("audit export");

export interface VerifiedFile {
  size: number;
  stream: Readable;
  /** False if the file changed after it was hashed (size or mtime). */
  unchanged(): Promise<boolean>;
  close(): Promise<void>;
}

/**
 * Open a regular file and prove its SHA-256 matches the signed manifest BEFORE any
 * byte is sent. The returned stream reads the same open descriptor, so replacing
 * the path afterwards cannot swap the content; an in-place edit is caught by
 * `unchanged()`. Every failure is "not found" and never names the path.
 */
export async function openVerifiedFile(
  filePath: string,
  sha256: string,
): Promise<VerifiedFile> {
  const handle = await open(filePath, "r").catch(() => {
    throw notFound();
  });
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw notFound();
    const hash = createHash("sha256");
    for await (const chunk of handle.createReadStream({
      start: 0,
      autoClose: false,
    }) as AsyncIterable<Buffer>)
      hash.update(chunk);
    if (hash.digest("hex") !== sha256) throw notFound();
    return {
      size: before.size,
      stream: handle.createReadStream({ start: 0, autoClose: true }),
      unchanged: async () => {
        const now = await handle.stat();
        return now.size === before.size && now.mtimeMs === before.mtimeMs;
      },
      close: () => handle.close(),
    };
  } catch (error) {
    await handle.close();
    throw error instanceof NotFoundError ? error : notFound();
  }
}

/** Send a verified file. A stream error destroys the connection (the client sees a short body). */
export async function sendVerified(
  res: ServerResponse,
  file: VerifiedFile,
  headers: Record<string, string>,
): Promise<void> {
  if (!(await file.unchanged())) {
    await file.close();
    throw notFound();
  }
  res.writeHead(200, { ...headers, "Content-Length": String(file.size) });
  await new Promise<void>((resolve) => {
    pipeline(file.stream, res, (error) => {
      if (error) {
        console.error("audit export stream failed");
        res.destroy();
      }
      resolve();
    });
  });
}
