import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { appendFile, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { after, test } from "node:test";
import { runtimeDb } from "../testing/fixtures.js";
import { NotFoundError, RoleForbiddenError } from "../domain/errors.js";
import type { ControlRequest } from "../api/http.js";
import { AuditController, type AuditOptions } from "./controller.js";
import { queuedExport } from "./storage-fixtures.js";
import { processNextAuditExport } from "./worker.js";

const db = runtimeDb(5);
const keys = generateKeyPairSync("ed25519");
const dir = await mkdtemp(path.join(os.tmpdir(), "greenguard-audit-dl-"));
const options: AuditOptions = {
  directory: dir,
  publicKey: keys.publicKey,
  linkSecret: "download-secret-with-at-least-32-bytes",
};
after(async () => {
  await db.$disconnect();
  await rm(dir, { recursive: true, force: true });
});
const asRequest = (actor: unknown) => ({ actor }) as unknown as ControlRequest;

function fakeResponse() {
  const sink = new PassThrough();
  const seen: { status?: number; headers?: Record<string, string> } = {};
  const res = Object.assign(sink, {
    writeHead: (status: number, headers: Record<string, string>) => {
      seen.status = status;
      seen.headers = headers;
      return res;
    },
  });
  return {
    res,
    seen,
    body: () =>
      new Promise<string>((resolve) => {
        const chunks: Buffer[] = [];
        sink.on("data", (c: Buffer) => chunks.push(c));
        sink.on("end", () => resolve(Buffer.concat(chunks).toString()));
        sink.on("close", () => resolve(Buffer.concat(chunks).toString()));
      }),
  };
}

async function ready(label: string) {
  const job = await queuedExport(db, label);
  assert.equal(
    await processNextAuditExport(db, {
      destinationDirectory: dir,
      privateKey: keys.privateKey,
      publicKeyId: "dl",
    }),
    true,
  );
  const controller = new AuditController(db, options);
  const link = (await controller.link(
    asRequest(job.admin),
    job.tenantId,
    job.jobId,
  )) as { url: string; token: string; expiresAt: string };
  return { ...job, controller, link };
}

test("DL1 the download token is issued as a header value, never inside the URL", async () => {
  const a = await ready("dl1");
  assert.equal(
    a.link.url,
    `/v1/organizations/${a.tenantId}/exports/${a.jobId}/download`,
  );
  assert.doesNotMatch(a.link.url, /token|\?/);
  assert.match(a.link.token, /^\d{13}\.[\w-]+$/);
});

test("DL2 a valid header token streams the verified file; a missing token is forbidden", async () => {
  const a = await ready("dl2");
  const out = fakeResponse();
  await a.controller.download(
    asRequest(a.admin),
    a.tenantId,
    a.jobId,
    a.link.token,
    out.res as never,
  );
  assert.equal(out.seen.status, 200);
  assert.equal(out.seen.headers?.["Cache-Control"], "no-store");
  assert.equal(
    out.seen.headers?.["Content-Disposition"],
    `attachment; filename="audit-${a.jobId}.jsonl"`,
  );
  assert.match(await out.body(), new RegExp(a.tenantId));
  await assert.rejects(
    a.controller.download(
      asRequest(a.admin),
      a.tenantId,
      a.jobId,
      undefined,
      fakeResponse().res as never,
    ),
    RoleForbiddenError,
  );
});

test("DL3 a file altered on disk is never sent", async () => {
  const a = await ready("dl3");
  await appendFile(path.join(dir, a.jobId, "audit.jsonl"), '{"forged":true}\n');
  const out = fakeResponse();
  await assert.rejects(
    a.controller.download(
      asRequest(a.admin),
      a.tenantId,
      a.jobId,
      a.link.token,
      out.res as never,
    ),
    (e: unknown) =>
      e instanceof NotFoundError && !(e as Error).message.includes(dir),
  );
  assert.equal(out.seen.status, undefined);
});
