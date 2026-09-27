import { createHmac, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from "@nestjs/common";
import type { ServerResponse } from "node:http";
import {
  MAX_PRESIGN_TTL_SECONDS,
  attachmentDisposition,
  verifyAuditManifest,
  type AuditManifest,
  type ExportStorage,
} from "@greenguard/audit";
import type { Db } from "../db/client.js";
import {
  InvalidInputError,
  NotFoundError,
  RoleForbiddenError,
} from "../domain/errors.js";
import { identityIdOf } from "../domain/ids.js";
import { CONTROL_DB } from "../api/controllers.js";
import { IdentityGuard } from "../api/guards.js";
import { commandFrom, type ControlRequest } from "../api/http.js";
import {
  auditDownload,
  getAuditJob,
  listAuditPage,
  requestAuditExport,
} from "./store.js";
import type { KeyObject } from "node:crypto";
import type { AuditSources } from "./owners.js";
import { issueExportLinks } from "./s3-download.js";
import { openVerifiedFile, sendVerified } from "./verified-file.js";

const EXPORT_RESOURCE = "audit export";
export const AUDIT_OPTIONS = "CONTROL_AUDIT_OPTIONS";
export interface AuditOptions {
  /** Filesystem backend: exports served through the HMAC-signed download route. */
  directory?: string;
  publicKey: KeyObject;
  linkSecret?: string;
  /** Object store: `link` returns presigned URLs and the HMAC route is not used. */
  storage?: ExportStorage;
  presignTtlSeconds?: number;
  sources?: AuditSources;
}
async function readJson<T>(file: string): Promise<T> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch {
    throw new NotFoundError(EXPORT_RESOURCE);
  }
}
const mac = (secret: string | undefined, message: string) => {
  if (!secret) throw new NotFoundError(EXPORT_RESOURCE);
  return createHmac("sha256", secret).update(message).digest();
};
export function signedToken(
  options: AuditOptions,
  tenantId: string,
  jobId: string,
  actorId: string,
  expires: number,
) {
  const message = `${tenantId}.${jobId}.${actorId}.${expires}`;
  return `${expires}.${mac(options.linkSecret, message).toString("base64url")}`;
}
export function checkToken(
  options: AuditOptions,
  token: string | undefined,
  tenantId: string,
  jobId: string,
  actorId: string,
) {
  const [rawExpiry, rawMac, extra] = token?.split(".") ?? [];
  if (extra || !rawExpiry || !rawMac || !/^\d{10,13}$/.test(rawExpiry))
    throw new RoleForbiddenError();
  const expires = Number(rawExpiry);
  if (expires < Date.now() || expires > Date.now() + 5 * 60_000)
    throw new RoleForbiddenError();
  const expected = mac(
    options.linkSecret,
    `${tenantId}.${jobId}.${actorId}.${expires}`,
  );
  const actual = Buffer.from(rawMac, "base64url");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
    throw new RoleForbiddenError();
}

@Controller("v1/organizations/:tenantId")
@UseGuards(IdentityGuard)
export class AuditController {
  constructor(
    @Inject(CONTROL_DB) private readonly db: Db,
    @Inject(AUDIT_OPTIONS) private readonly options: AuditOptions,
  ) {}

  @Get("audit-events")
  list(
    @Req() req: ControlRequest,
    @Param("tenantId") tenantId: string,
    @Query("cursor") cursor?: string,
    @Query("limit") limit?: string,
    @Query("from") from?: string,
    @Query("to") to?: string,
  ) {
    if (limit && !/^[1-9]\d*$/.test(limit))
      throw new InvalidInputError("invalid audit limit");
    return listAuditPage(
      this.db,
      req.actor!,
      tenantId,
      { cursor, limit: limit ? Number(limit) : undefined, from, to },
      this.options.sources,
    );
  }

  @Post("exports")
  @HttpCode(202)
  async request(
    @Req() req: ControlRequest,
    @Param("tenantId") tenantId: string,
    @Body() body: unknown,
  ) {
    if (
      !body ||
      typeof body !== "object" ||
      Array.isArray(body) ||
      Object.keys(body).some(
        (k) => !["type", "from", "to", "format"].includes(k),
      )
    )
      throw new InvalidInputError("invalid export request");
    const input = body as Record<string, unknown>;
    if (
      input.type !== "audit" ||
      (input.format !== "jsonl" && input.format !== "csv") ||
      typeof input.from !== "string" ||
      typeof input.to !== "string"
    )
      throw new InvalidInputError("invalid export request");
    return requestAuditExport(
      this.db,
      req.actor!,
      tenantId,
      { from: input.from, to: input.to, format: input.format },
      commandFrom(req),
    );
  }

  @Get("exports/:jobId")
  async status(
    @Req() req: ControlRequest,
    @Param("tenantId") tenantId: string,
    @Param("jobId") jobId: string,
  ) {
    const job = await getAuditJob(this.db, req.actor!, tenantId, jobId);
    return { jobId, state: job.state, expiresAt: job.expires_at.toISOString() };
  }

  @Get("exports/:jobId/link")
  async link(
    @Req() req: ControlRequest,
    @Param("tenantId") tenantId: string,
    @Param("jobId") jobId: string,
  ) {
    const job = await getAuditJob(this.db, req.actor!, tenantId, jobId);
    if (job.state !== "ready" || job.expires_at <= new Date())
      throw new NotFoundError(EXPORT_RESOURCE);
    if (this.options.storage) return this.presignedLinks(req, tenantId, job);
    const expiry = Math.min(Date.now() + 5 * 60_000, job.expires_at.getTime());
    const actorId = identityIdOf(req.actor!.issuer, req.actor!.subject);
    // The token is a bearer value: it travels in the X-Download-Token header, never in
    // the URL, so it cannot land in access logs, proxies or browser history.
    return {
      url: `/v1/organizations/${tenantId}/exports/${jobId}/download`,
      token: signedToken(this.options, tenantId, jobId, actorId, expiry),
      expiresAt: new Date(expiry).toISOString(),
    };
  }

  /** Only reached after `getAuditJob` authorized the caller for this tenant and job. */
  private async presignedLinks(
    req: ControlRequest,
    tenantId: string,
    job: Awaited<ReturnType<typeof getAuditJob>>,
  ) {
    const links = await issueExportLinks(
      this.options.storage!,
      job,
      this.options.presignTtlSeconds ?? MAX_PRESIGN_TTL_SECONDS,
    );
    await auditDownload(this.db, req.actor!, tenantId, job.job_id);
    return links;
  }

  @Get("exports/:jobId/download")
  async download(
    @Req() req: ControlRequest,
    @Param("tenantId") tenantId: string,
    @Param("jobId") jobId: string,
    @Headers("x-download-token") token: string | undefined,
    @Res() res: ServerResponse,
  ) {
    const job = await getAuditJob(this.db, req.actor!, tenantId, jobId);
    if (job.state !== "ready" || job.expires_at <= new Date())
      throw new NotFoundError(EXPORT_RESOURCE);
    if (!this.options.directory) throw new NotFoundError(EXPORT_RESOURCE);
    checkToken(
      this.options,
      token,
      tenantId,
      jobId,
      identityIdOf(req.actor!.issuer, req.actor!.subject),
    );
    const dir = path.join(this.options.directory, jobId);
    const manifest = await readJson<AuditManifest>(
      path.join(dir, "manifest.json"),
    );
    const signature = await readFile(path.join(dir, "signature"), "utf8").catch(
      () => "",
    );
    if (
      manifest.tenantId !== tenantId ||
      manifest.fileSha256 !== job.file_sha256 ||
      !verifyAuditManifest(manifest, signature, this.options.publicKey)
    )
      throw new NotFoundError(EXPORT_RESOURCE);
    // Hash the file against the signed manifest before sending; never send unverified bytes.
    const file = await openVerifiedFile(
      path.join(dir, job.format === "csv" ? "audit.csv" : "audit.jsonl"),
      manifest.fileSha256,
    );
    try {
      await auditDownload(this.db, req.actor!, tenantId, jobId);
    } catch (error) {
      await file.close();
      throw error;
    }
    await sendVerified(res, file, {
      "Content-Type":
        job.format === "csv" ? "text/csv" : "application/x-ndjson",
      "Content-Disposition": attachmentDisposition(
        `audit-${jobId}.${job.format}`,
      ),
      "Cache-Control": "no-store",
    });
  }
}
