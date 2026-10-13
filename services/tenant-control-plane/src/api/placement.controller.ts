import {
  Controller,
  Body,
  Post,
  Delete,
  Get,
  Inject,
  Param,
  Query,
  Req,
  Res,
  UseGuards,
} from "@nestjs/common";
import type { ServerResponse } from "node:http";
import type { Db } from "../db/client.js";
import { resolveTenant } from "../domain/placement.js";
import {
  acquireReadLease,
  admitReadLease,
  releaseReadLease,
} from "../domain/read-leases.js";
import { InvalidInputError } from "../domain/errors.js";
import { CONTROL_DB } from "./controllers.js";
import { IdentityGuard, LookupGuard } from "./guards.js";
import type { ControlRequest } from "./http.js";
import { strictBody } from "./http.js";

function noRouteHints(
  req: ControlRequest,
  query: Record<string, unknown>,
  res: ServerResponse,
  body?: unknown,
) {
  res.setHeader("Cache-Control", "no-store");
  if (body !== undefined) strictBody(body, {});
  if (
    Object.keys(query).length ||
    req.headers["x-shard-id"] !== undefined ||
    req.headers["x-shard-incarnation"] !== undefined ||
    req.headers["x-placement-epoch"] !== undefined
  )
    throw new InvalidInputError("placement hints are not accepted");
}

@Controller("v1/internal/placements")
@UseGuards(LookupGuard)
export class InternalPlacementController {
  constructor(@Inject(CONTROL_DB) private readonly db: Db) {}

  @Post(":tenantId/read-leases")
  async acquire(
    @Param("tenantId") tenantId: string,
    @Req() req: ControlRequest,
    @Query() query: Record<string, unknown>,
    @Res({ passthrough: true }) res: ServerResponse,
    @Body() body: unknown,
  ) {
    noRouteHints(req, query, res, body);
    return acquireReadLease(this.db, tenantId);
  }

  @Post(":tenantId/read-leases/:leaseId/admit")
  async admit(
    @Param("tenantId") tenantId: string,
    @Param("leaseId") leaseId: string,
    @Req() req: ControlRequest,
    @Query() query: Record<string, unknown>,
    @Res({ passthrough: true }) res: ServerResponse,
    @Body() body: unknown,
  ) {
    noRouteHints(req, query, res, body);
    await admitReadLease(this.db, tenantId, leaseId);
    return { admitted: true };
  }

  @Delete(":tenantId/read-leases/:leaseId")
  async release(
    @Param("tenantId") tenantId: string,
    @Param("leaseId") leaseId: string,
    @Req() req: ControlRequest,
    @Query() query: Record<string, unknown>,
    @Res({ passthrough: true }) res: ServerResponse,
    @Body() body: unknown,
  ) {
    noRouteHints(req, query, res, body);
    await releaseReadLease(this.db, tenantId, leaseId);
    return { released: true };
  }

  // Trusted service credential; callers derive tenantId from their previously
  // verified principal/device/event context. This route is never edge-exposed.
  @Get(":tenantId")
  async resolve(
    @Param("tenantId") tenantId: string,
    @Req() req: ControlRequest,
    @Query() query: Record<string, unknown>,
    @Res({ passthrough: true }) res: ServerResponse,
  ) {
    noRouteHints(req, query, res);
    return resolveTenant(this.db, tenantId);
  }
}

@Controller("v1/organizations")
@UseGuards(IdentityGuard)
export class OrganizationPlacementController {
  constructor(@Inject(CONTROL_DB) private readonly db: Db) {}

  @Get(":tenantId/placement")
  async resolve(
    @Param("tenantId") tenantId: string,
    @Req() req: ControlRequest,
    @Query() query: Record<string, unknown>,
    @Res({ passthrough: true }) res: ServerResponse,
  ) {
    noRouteHints(req, query, res);
    return resolveTenant(this.db, tenantId, req.actor!);
  }
}
