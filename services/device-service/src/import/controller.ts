import { Body, Controller, Inject, Post, Req, UseGuards } from "@nestjs/common";
import type { Db } from "../db/client.js";
import { DB } from "../api/inventory.controller.js";
import { InvalidInputError } from "../inventory/errors.js";
import { admitImport } from "./admission.js";
import { ImportGuard, type ImportRequest } from "./auth.js";

export const IMPORT_SOURCE_ID = "IMPORT_SOURCE_ID";

@Controller("v1/internal/inventory")
@UseGuards(ImportGuard)
export class ImportController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(IMPORT_SOURCE_ID) private readonly sourceId: string,
  ) {}
  @Post("imports")
  async admit(@Req() req: ImportRequest, @Body() body: unknown) {
    if (
      req.headers["x-tenant-id"] !== undefined ||
      req.headers["tenant-id"] !== undefined
    )
      throw new InvalidInputError("tenant override header is not supported");
    const principal = req.importPrincipal!;
    return admitImport(
      this.db,
      {
        tenantId: principal.tenant_id,
        actorType: "service",
        actorId: principal.principal_id,
        correlationId: req.correlationId!,
        traceparent: req.traceparent!,
        idempotencyKey: "source-coordinate",
      },
      body,
      this.sourceId,
    );
  }
}
