import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  ExportStorageError,
  exportObject,
  type ExportStorage,
  type PutBody,
  type PutMeta,
  type StoredObject,
} from "./storage.js";
import { FilesystemExportStorage } from "./storage-fs.js";
import {
  isTransientStorageError,
  publishSignedExport,
} from "./storage-publish.js";
import { writeSignedAuditExport } from "./stream.js";
import type { ExportRow } from "./index.js";

const tenantId = "11111111-1111-4111-8111-111111111111";
const jobId = "33333333-3333-4333-8333-333333333333";
const keys = generateKeyPairSync("ed25519");
const noSleep = async () => undefined;

async function* rows(): AsyncGenerator<ExportRow> {
  yield {
    tenantId,
    auditId: "a1",
    occurredAt: "2026-09-25T00:00:00Z",
    actorId: "x",
    action: "member.revoked",
    resourceType: "membership",
    resourceId: "m",
    outcome: "succeeded",
  };
}

async function exportFixture(format: "jsonl" | "csv" = "jsonl") {
  const root = await mkdtemp(path.join(tmpdir(), "gg-publish-"));
  const built = await writeSignedAuditExport({
    tenantId,
    jobId,
    rows: rows(),
    format,
    destinationDirectory: root,
    privateKey: keys.privateKey,
    publicKeyId: "k",
  });
  return {
    root,
    ...built,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

/** In-memory store that records the operation order and can inject faults. */
class MemoryStorage implements ExportStorage {
  readonly kind = "s3" as const;
  readonly objects = new Map<string, { bytes: Buffer; meta: PutMeta }>();
  readonly log: string[] = [];
  failPuts: (Error | null)[] = [];
  tamper: ((s: StoredObject) => StoredObject | null) | null = null;

  async put(key: string, body: PutBody, meta: PutMeta): Promise<StoredObject> {
    this.log.push(`put:${key.split("/").pop()}`);
    const failure = this.failPuts.shift();
    if (failure) throw failure;
    const bytes =
      body instanceof Uint8Array
        ? Buffer.from(body)
        : await readFile(body.path);
    this.objects.set(key, { bytes, meta });
    return this.describe(key)!;
  }
  async head(key: string) {
    this.log.push(`head:${key.split("/").pop()}`);
    const stored = this.describe(key);
    return stored && this.tamper ? this.tamper(stored) : stored;
  }
  presignGet(): Promise<string> {
    throw new ExportStorageError("unsupported", "n/a");
  }
  private describe(key: string): StoredObject | null {
    const hit = this.objects.get(key);
    if (!hit) return null;
    const sha256 = createHash("sha256").update(hit.bytes).digest("hex");
    return {
      key,
      size: hit.bytes.length,
      sha256,
      checksumSha256: sha256,
      tenantId: hit.meta.tenantId,
      jobId: hit.meta.jobId,
      encryption: "AES256",
    };
  }
}

const transient = () =>
  Object.assign(new Error("slow down"), {
    name: "SlowDown",
    $metadata: { httpStatusCode: 503 },
  });

test("P01 uploads export, signature, then manifest last, head-verifying each before the next", async () => {
  const fx = await exportFixture();
  try {
    const storage = new MemoryStorage();
    await publishSignedExport({
      storage,
      tenantId,
      jobId,
      format: "jsonl",
      directory: fx.directory,
      manifest: fx.manifest,
      sleep: noSleep,
    });
    assert.deepEqual(storage.log, [
      "put:audit.jsonl",
      "head:audit.jsonl",
      "put:signature",
      "head:signature",
      "put:manifest.json",
      "head:manifest.json",
    ]);
    const stored = storage.objects.get(
      exportObject(tenantId, jobId, "jsonl", "export").key,
    )!;
    assert.equal(
      createHash("sha256").update(stored.bytes).digest("hex"),
      fx.manifest.fileSha256,
    );
    assert.equal(
      storage.objects.get(
        exportObject(tenantId, jobId, "jsonl", "manifest").key,
      )!.meta.contentType,
      "application/json",
    );
  } finally {
    await fx.cleanup();
  }
});

test("P02 transient errors retry with growing backoff and then succeed", async () => {
  const fx = await exportFixture();
  try {
    const storage = new MemoryStorage();
    storage.failPuts = [transient(), transient()];
    const sleeps: number[] = [];
    await publishSignedExport({
      storage,
      tenantId,
      jobId,
      format: "jsonl",
      directory: fx.directory,
      manifest: fx.manifest,
      retry: { attempts: 4, baseDelayMs: 100 },
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    assert.equal(storage.objects.size, 3);
    assert.equal(sleeps.length, 2);
    assert.ok(sleeps[1]! > sleeps[0]! && sleeps[0]! >= 100);
  } finally {
    await fx.cleanup();
  }
});

test("P03 a non-transient error is not retried and nothing later is uploaded", async () => {
  const fx = await exportFixture();
  try {
    const storage = new MemoryStorage();
    storage.failPuts = [
      Object.assign(new Error("denied"), {
        name: "AccessDenied",
        $metadata: { httpStatusCode: 403 },
      }),
    ];
    await assert.rejects(
      publishSignedExport({
        storage,
        tenantId,
        jobId,
        format: "jsonl",
        directory: fx.directory,
        manifest: fx.manifest,
        sleep: noSleep,
      }),
      /denied/,
    );
    assert.deepEqual(storage.log, ["put:audit.jsonl"]);
  } finally {
    await fx.cleanup();
  }
});

test("P04 exhausted retries reject and the manifest commit marker is never written", async () => {
  const fx = await exportFixture();
  try {
    const storage = new MemoryStorage();
    storage.failPuts = [transient(), transient(), transient()];
    await assert.rejects(
      publishSignedExport({
        storage,
        tenantId,
        jobId,
        format: "jsonl",
        directory: fx.directory,
        manifest: fx.manifest,
        retry: { attempts: 3, baseDelayMs: 1 },
        sleep: noSleep,
      }),
      /slow down/,
    );
    assert.equal(storage.objects.size, 0);
    assert.equal(
      storage.log.some((l) => l.includes("manifest")),
      false,
    );
  } finally {
    await fx.cleanup();
  }
});

test("P05 head verification rejects a missing, foreign-tenant or altered object", async () => {
  const fx = await exportFixture();
  try {
    const cases: [string, (s: StoredObject) => StoredObject | null, string][] =
      [
        ["missing", () => null, "missing"],
        [
          "foreign tenant",
          (s) => ({ ...s, tenantId: "22222222-2222-4222-8222-222222222222" }),
          "tenant_mismatch",
        ],
        ["altered bytes", (s) => ({ ...s, sha256: "00" }), "checksum_mismatch"],
        [
          "short object",
          (s) => ({ ...s, size: s.size - 1 }),
          "checksum_mismatch",
        ],
      ];
    for (const [label, tamper, code] of cases) {
      const storage = new MemoryStorage();
      storage.tamper = tamper;
      await assert.rejects(
        publishSignedExport({
          storage,
          tenantId,
          jobId,
          format: "jsonl",
          directory: fx.directory,
          manifest: fx.manifest,
          sleep: noSleep,
        }),
        (e: unknown) => e instanceof ExportStorageError && e.code === code,
        label,
      );
    }
  } finally {
    await fx.cleanup();
  }
});

test("P06 a retry after a crash overwrites the same three keys", async () => {
  const fx = await exportFixture("csv");
  try {
    const storage = new MemoryStorage();
    const options = {
      storage,
      tenantId,
      jobId,
      format: "csv" as const,
      directory: fx.directory,
      manifest: fx.manifest,
      sleep: noSleep,
    };
    await publishSignedExport(options);
    await publishSignedExport(options);
    assert.equal(storage.objects.size, 3);
    assert.deepEqual(
      [...storage.objects.keys()].sort(),
      [
        exportObject(tenantId, jobId, "csv", "export").key,
        exportObject(tenantId, jobId, "csv", "manifest").key,
        exportObject(tenantId, jobId, "csv", "signature").key,
      ].sort(),
    );
  } finally {
    await fx.cleanup();
  }
});

test("P07 transient classification covers 5xx, throttling and network resets only", () => {
  const status = (code: number, name = "Err") =>
    Object.assign(new Error(name), {
      name,
      $metadata: { httpStatusCode: code },
    });
  assert.equal(isTransientStorageError(status(500)), true);
  assert.equal(isTransientStorageError(status(503)), true);
  assert.equal(isTransientStorageError(status(429)), true);
  assert.equal(isTransientStorageError(status(400, "RequestTimeout")), true);
  assert.equal(
    isTransientStorageError(
      Object.assign(new Error("x"), { code: "ECONNRESET" }),
    ),
    true,
  );
  assert.equal(isTransientStorageError(status(403)), false);
  assert.equal(isTransientStorageError(status(400, "BadDigest")), false);
  assert.equal(
    isTransientStorageError(new ExportStorageError("checksum_mismatch", "x")),
    false,
  );
});

test("F01 filesystem storage keeps the legacy <root>/<job>/<file> layout and is idempotent", async () => {
  const fx = await exportFixture();
  const root = await mkdtemp(path.join(tmpdir(), "gg-fs-store-"));
  try {
    const storage = new FilesystemExportStorage(root);
    const options = {
      storage,
      tenantId,
      jobId,
      format: "jsonl" as const,
      directory: fx.directory,
      manifest: fx.manifest,
    };
    await publishSignedExport(options);
    await publishSignedExport(options);
    assert.deepEqual(
      (await readdir(path.join(root, jobId)))
        .filter((n) => !n.startsWith("."))
        .sort(),
      ["audit.jsonl", "manifest.json", "signature"],
    );
    assert.equal(
      await readFile(path.join(root, jobId, "signature"), "utf8"),
      fx.signature,
    );
    assert.equal(
      (await readdir(path.join(root, jobId))).some((n) => n.includes(".tmp")),
      false,
    );
    const head = await storage.head(
      exportObject(tenantId, jobId, "jsonl", "export").key,
    );
    assert.equal(head?.tenantId, tenantId);
    assert.equal(head?.sha256, fx.manifest.fileSha256);
    assert.equal(
      await storage.head(
        exportObject(
          tenantId,
          "44444444-4444-4444-8444-444444444444",
          "jsonl",
          "export",
        ).key,
      ),
      null,
    );
    await assert.rejects(
      (storage as ExportStorage).presignGet(
        exportObject(tenantId, jobId, "jsonl", "export").key,
        60,
        { filename: "a", contentType: "text/plain" },
      ),
      (e: unknown) =>
        e instanceof ExportStorageError && e.code === "unsupported",
    );
  } finally {
    await fx.cleanup();
    await rm(root, { recursive: true, force: true });
  }
});

test("F02 filesystem put refuses a mismatching body and a foreign-tenant key", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "gg-fs-store-"));
  try {
    const storage = new FilesystemExportStorage(root);
    const file = path.join(root, "src.bin");
    await writeFile(file, "abc");
    const key = exportObject(tenantId, jobId, "jsonl", "export").key;
    const meta: PutMeta = {
      tenantId,
      jobId,
      contentType: "text/plain",
      filename: "a.txt",
    };
    await assert.rejects(
      storage.put(key, { path: file }, { ...meta, expectedSha256: "00" }),
      (e: unknown) =>
        e instanceof ExportStorageError && e.code === "checksum_mismatch",
    );
    await assert.rejects(
      storage.put(
        key,
        { path: file },
        { ...meta, tenantId: "22222222-2222-4222-8222-222222222222" },
      ),
      (e: unknown) =>
        e instanceof ExportStorageError && e.code === "invalid_key",
    );
    assert.deepEqual(
      (await readdir(root)).filter((n) => n !== "src.bin"),
      [],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
