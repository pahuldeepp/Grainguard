import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import {
  createS3ExportStorage,
  exportObject,
  readS3StorageConfig,
} from "@greenguard/audit";
import { runtimeDb } from "../testing/fixtures.js";
import type { ControlRequest } from "../api/http.js";
import { AuditController } from "./controller.js";
import type { ExportLinks } from "./s3-download.js";
import { expireLease, jobRow, queuedExport } from "./storage-fixtures.js";
import { processNextAuditExport } from "./worker.js";

// Opt-in: `make audit-s3-test` starts MinIO (infra/objectstore) and sets AUDIT_S3_LIVE=1.
const live = { skip: process.env.AUDIT_S3_LIVE !== "1" };
const s3Env = {
  AUDIT_EXPORT_S3_BUCKET: "greenguard-audit-exports-local",
  AUDIT_EXPORT_S3_REGION: "us-east-1",
  AUDIT_EXPORT_S3_ENDPOINT: "http://127.0.0.1:59000",
  AUDIT_EXPORT_S3_ACCESS_KEY_ID: process.env.OBJECTSTORE_ROOT_USER ?? "",
  AUDIT_EXPORT_S3_SECRET_ACCESS_KEY:
    process.env.OBJECTSTORE_ROOT_PASSWORD ?? "",
  AUDIT_EXPORT_S3_PRESIGN_TTL_SECONDS: "60",
};
const db = runtimeDb(5);
const keys = generateKeyPairSync("ed25519");
const work = await mkdtemp(path.join(os.tmpdir(), "greenguard-audit-s3-"));
after(async () => {
  await db.$disconnect();
  await rm(work, { recursive: true, force: true });
});
const storage = () =>
  createS3ExportStorage(readS3StorageConfig(s3Env)!, {
    partSizeBytes: 5 * 1024 * 1024,
  });
const asRequest = (actor: unknown) => ({ actor }) as unknown as ControlRequest;
const sha = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
const get = async (url: string) => fetch(url);
const bytesOf = async (url: string) =>
  Buffer.from(await (await get(url)).arrayBuffer());

async function exported(label: string, format: "jsonl" | "csv" = "jsonl") {
  const job = await queuedExport(db, label, format);
  const store = storage();
  assert.equal(
    await processNextAuditExport(db, {
      storage: store,
      privateKey: keys.privateKey,
      publicKeyId: "live-s3",
      workDirectory: work,
    }),
    true,
  );
  const controller = new AuditController(db, {
    storage: store,
    presignTtlSeconds: 60,
    publicKey: keys.publicKey,
  });
  const links = (await controller.link(
    asRequest(job.admin),
    job.tenantId,
    job.jobId,
  )) as ExportLinks;
  return { ...job, store, controller, links };
}

test(
  "S3X1 export -> upload -> head-verify -> presigned HTTP download verifies with the Ed25519 CLI",
  live,
  async () => {
    const a = await exported("s3x1", "csv");
    const response = await get(a.links.url);
    assert.equal(response.status, 200);
    assert.equal(
      response.headers.get("content-disposition"),
      `attachment; filename="audit-${a.jobId}.csv"`,
    );
    assert.equal(
      response.headers.get("x-amz-server-side-encryption"),
      "AES256",
    );
    const file = Buffer.from(await response.arrayBuffer());
    assert.equal(sha(file), a.links.sha256);
    const directory = await mkdtemp(path.join(work, "verify-"));
    const pem = path.join(directory, "public.pem");
    await writeFile(
      pem,
      keys.publicKey.export({ type: "spki", format: "pem" }),
    );
    await writeFile(path.join(directory, "audit.csv"), file);
    await writeFile(
      path.join(directory, "manifest.json"),
      await bytesOf(a.links.manifestUrl),
    );
    await writeFile(
      path.join(directory, "signature"),
      await bytesOf(a.links.signatureUrl),
    );
    const cli = new URL(
      "../../../../packages/audit/dist/verify-cli.js",
      import.meta.url,
    ).pathname;
    const run = (audit: string) =>
      spawnSync(
        process.execPath,
        [
          cli,
          audit,
          path.join(directory, "manifest.json"),
          path.join(directory, "signature"),
          pem,
        ],
        { encoding: "utf8" },
      );
    const good = run(path.join(directory, "audit.csv"));
    assert.equal(good.status, 0, good.stderr);
    assert.match(good.stdout, /audit export verified/);
    await writeFile(
      path.join(directory, "tampered.csv"),
      Buffer.concat([file, Buffer.from("x")]),
    );
    assert.equal(run(path.join(directory, "tampered.csv")).status, 1);
    const head = await a.store.head(
      exportObject(a.tenantId, a.jobId, "csv", "export").key,
    );
    assert.equal(head?.encryption, "AES256");
    assert.equal(head?.tenantId, a.tenantId);
  },
);

test("S3X2 an expired presigned URL is rejected", live, async () => {
  const a = await exported("s3x2");
  const short = await a.store.presignGet(
    exportObject(a.tenantId, a.jobId, "jsonl", "export").key,
    1,
    { filename: "x.jsonl", contentType: "application/x-ndjson" },
  );
  assert.equal((await get(short)).status, 200);
  await new Promise((resolve) => setTimeout(resolve, 2500));
  assert.equal((await get(short)).status, 403);
});

test(
  "S3X3 tenant A's URL cannot fetch tenant B's object and a tampered URL fails",
  live,
  async () => {
    const a = await exported("s3x3a");
    const b = await exported("s3x3b");
    assert.equal((await get(b.links.url)).status, 200);
    const swapped = a.links.url
      .replace(a.tenantId, b.tenantId)
      .replace(a.jobId, b.jobId);
    assert.notEqual(swapped, a.links.url);
    assert.equal((await get(swapped)).status, 403, "signature covers the key");
    const url = new URL(a.links.url);
    const flip = new URL(url);
    flip.searchParams.set("X-Amz-Signature", "0".repeat(64));
    assert.equal((await get(flip.toString())).status, 403);
    const longer = new URL(url);
    longer.searchParams.set("X-Amz-Expires", "3600");
    assert.equal((await get(longer.toString())).status, 403);
    const unsigned = new URL(url);
    unsigned.search = "";
    assert.equal(
      (await get(unsigned.toString())).status,
      403,
      "bucket is private",
    );
    const download = new URL(url);
    download.searchParams.set("response-content-disposition", "inline");
    assert.equal(
      (await get(download.toString())).status,
      403,
      "disposition override is signed",
    );
  },
);

test(
  "S3X4 B's admin cannot obtain links to A's export and A's link call presigns only A's keys",
  live,
  async () => {
    const a = await exported("s3x4a");
    const b = await exported("s3x4b");
    await assert.rejects(
      b.controller.link(asRequest(b.admin), a.tenantId, a.jobId),
    );
    await assert.rejects(
      a.controller.link(asRequest(a.admin), a.tenantId, b.jobId),
    );
    assert.ok(
      a.links.url.includes(a.tenantId) && !a.links.url.includes(b.tenantId),
    );
  },
);

test(
  "S3X5 killing the worker mid-upload leaves a claimable job and recovery yields one object set",
  live,
  async () => {
    const job = await queuedExport(db, "s3x5");
    const child = spawn(
      process.execPath,
      [new URL("../testing/crash-worker.js", import.meta.url).pathname],
      {
        env: {
          ...process.env,
          ...s3Env,
          AUDIT_CRASH_PRIVATE_KEY_PEM: keys.privateKey.export({
            type: "pkcs8",
            format: "pem",
          }) as string,
        },
        stdio: "inherit",
      },
    );
    const signal = await new Promise((resolve) =>
      child.on("exit", (_code, sig) => resolve(sig)),
    );
    assert.equal(signal, "SIGKILL");
    const store = storage();
    assert.equal((await jobRow(job.tenantId, job.jobId)).state, "running");
    assert.deepEqual(
      (await store.listKeys(job.tenantId, job.jobId))
        .map((k) => k.split("/").pop())
        .sort(),
      ["audit.jsonl", "signature"],
      "half-uploaded: no manifest commit marker",
    );
    await expireLease(job.tenantId, job.jobId);
    assert.equal(
      await processNextAuditExport(db, {
        storage: store,
        privateKey: keys.privateKey,
        publicKeyId: "live-s3",
        workDirectory: work,
      }),
      true,
    );
    const row = await jobRow(job.tenantId, job.jobId);
    assert.deepEqual(
      { state: row.state, attempts: row.attempts },
      { state: "ready", attempts: 2 },
    );
    assert.deepEqual(
      (await store.listKeys(job.tenantId, job.jobId))
        .map((k) => k.split("/").pop())
        .sort(),
      ["audit.jsonl", "manifest.json", "signature"],
    );
    assert.equal(
      await processNextAuditExport(db, {
        storage: store,
        privateKey: keys.privateKey,
        publicKeyId: "live-s3",
        workDirectory: work,
      }),
      false,
      "job completes once",
    );
  },
);

test(
  "S3X6 multipart upload keeps the SHA-256 and encryption intact",
  live,
  async () => {
    const a = await queuedExport(db, "s3x6");
    const store = storage();
    const body = randomBytes(12 * 1024 * 1024);
    const source = path.join(work, "big.bin");
    await writeFile(source, body);
    const object = exportObject(a.tenantId, a.jobId, "jsonl", "export");
    await store.put(
      object.key,
      { path: source },
      {
        tenantId: a.tenantId,
        jobId: a.jobId,
        contentType: object.contentType,
        filename: object.filename,
        expectedSha256: sha(body),
      },
    );
    const head = await store.head(object.key);
    assert.equal(head?.size, body.length);
    assert.equal(head?.sha256, sha(body));
    assert.equal(
      head?.checksumSha256,
      null,
      "multipart objects carry a composite checksum only",
    );
    assert.equal(head?.encryption, "AES256");
    const url = await store.presignGet(object.key, 60, object);
    assert.equal(sha(await bytesOf(url)), sha(body));
    await expireLease(a.tenantId, a.jobId);
    await processNextAuditExport(db, {
      storage: store,
      privateKey: keys.privateKey,
      publicKeyId: "live-s3",
      workDirectory: work,
    });
  },
);
