import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { adminQuery, runtimeDb } from "../testing/fixtures.js";
import { NotFoundError, RoleForbiddenError } from "../domain/errors.js";
import { acceptInvitation, inviteMember } from "../domain/store.js";
import type { ControlRequest } from "../api/http.js";
import { AuditController, type AuditOptions } from "./controller.js";
import type { ExportLinks } from "./s3-download.js";
import {
  FaultyStorage,
  command,
  queuedExport,
  settleJob,
} from "./storage-fixtures.js";
import { processNextAuditExport } from "./worker.js";

const db = runtimeDb(5);
const keys = generateKeyPairSync("ed25519");
const work = await mkdtemp(path.join(os.tmpdir(), "greenguard-audit-ctl-"));
after(async () => {
  await db.$disconnect();
  await rm(work, { recursive: true, force: true });
});
const asRequest = (actor: unknown) => ({ actor }) as unknown as ControlRequest;
const downloads = async (tenantId: string, jobId: string) =>
  (
    await adminQuery<{ n: string }>(
      "SELECT count(*)::text AS n FROM audit_export_actions WHERE tenant_id=$1 AND job_id=$2 AND action='downloaded'",
      [tenantId, jobId],
    )
  )[0]!.n;

async function readyExport(label: string) {
  const job = await queuedExport(db, label);
  const storage = new FaultyStorage();
  assert.equal(
    await processNextAuditExport(db, {
      storage,
      privateKey: keys.privateKey,
      publicKeyId: "ctl",
      workDirectory: work,
    }),
    true,
  );
  const options: AuditOptions = {
    storage,
    presignTtlSeconds: 120,
    publicKey: keys.publicKey,
  };
  return { ...job, storage, controller: new AuditController(db, options) };
}

test("S3L1 authorized admin gets presigned links and the issuance is audited", async () => {
  const a = await readyExport("ctl-a");
  a.storage.presigned.length = 0;
  const links = (await a.controller.link(
    asRequest(a.admin),
    a.tenantId,
    a.jobId,
  )) as ExportLinks;
  assert.match(
    links.url,
    /^https:\/\/objects\.invalid\/tenants\/.+\/audit\.jsonl\?ttl=120$/,
  );
  assert.match(links.manifestUrl, /manifest\.json/);
  assert.equal(typeof links.sha256, "string");
  assert.equal(a.storage.presigned.length, 3);
  assert.equal(await downloads(a.tenantId, a.jobId), "1");
});

test("S3L2 nothing is presigned for another tenant's admin, a viewer, or a foreign job", async () => {
  const a = await readyExport("ctl-a2");
  const b = await queuedExport(db, "ctl-b2");
  const viewerSubject = `viewer-${randomUUID()}`;
  const viewer = {
    issuer: "https://issuer.test",
    subject: viewerSubject,
    email: `${viewerSubject}@example.test`,
    emailVerified: true,
  };
  const invited = await inviteMember(
    db,
    a.admin,
    a.tenantId,
    { email: `${viewer.subject}@example.test`, role: "viewer" },
    command(),
  );
  await acceptInvitation(
    db,
    viewer,
    { token: invited.body.token as string },
    command(),
  );
  a.storage.presigned.length = 0;
  a.storage.heads.length = 0;
  await assert.rejects(
    a.controller.link(asRequest(b.admin), a.tenantId, a.jobId),
    RoleForbiddenError,
  );
  await assert.rejects(
    a.controller.link(asRequest(viewer), a.tenantId, a.jobId),
    RoleForbiddenError,
  );
  await assert.rejects(
    a.controller.link(asRequest(b.admin), b.tenantId, a.jobId),
    NotFoundError,
  );
  assert.deepEqual(
    [a.storage.presigned.length, a.storage.heads.length],
    [0, 0],
  );
  assert.equal(await downloads(a.tenantId, a.jobId), "0");
  await settleJob(b.tenantId, b.jobId);
});

test("S3L3 an object whose stored tenant is not the caller's tenant is never presigned", async () => {
  const a = await readyExport("ctl-a3");
  a.storage.presigned.length = 0;
  for (const object of a.storage.objects.values())
    object.meta = { ...object.meta, tenantId: randomUUID() };
  await assert.rejects(
    a.controller.link(asRequest(a.admin), a.tenantId, a.jobId),
    NotFoundError,
  );
  assert.equal(a.storage.presigned.length, 0);
  assert.equal(await downloads(a.tenantId, a.jobId), "0");
});

test("S3L4 a job that is not ready or has expired is not found", async () => {
  const a = await readyExport("ctl-a4");
  await adminQuery(
    "UPDATE audit_export_jobs SET expires_at=now()-interval '1 second' WHERE tenant_id=$1 AND job_id=$2",
    [a.tenantId, a.jobId],
  );
  await assert.rejects(
    a.controller.link(asRequest(a.admin), a.tenantId, a.jobId),
    NotFoundError,
  );
  const queued = await queuedExport(db, "ctl-q4");
  await assert.rejects(
    a.controller.link(asRequest(queued.admin), queued.tenantId, queued.jobId),
    NotFoundError,
  );
  await settleJob(queued.tenantId, queued.jobId);
});
