import { randomUUID } from "node:crypto";
import {
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from "@nestjs/common";
import { requireRole, type Principal } from "@greenguard/tenant-auth";
import type { Db } from "../db/client.js";
import { isUuid } from "../db/tenant.js";
import { parseCable } from "../inventory/cable-validation.js";
import {
  CableNotFoundError,
  changeCable,
  createCable,
  getCable,
  listCables,
  removeCable,
} from "../inventory/cables.js";
import { AuthGuard } from "./auth.guard.js";
import { commandContext } from "./context.js";
import { etag, parseIdempotencyKey, parseIfMatch, parsePage } from "./dto.js";
import { header, type ApiRequest, type ApiResponse } from "./http.js";
import { DB } from "./inventory.controller.js";

function authorized(req: ApiRequest, writing = false) {
  const principal = req.principal as Principal;
  requireRole(
    principal,
    ...(writing
      ? (["operator", "admin"] as const)
      : (["viewer", "operator", "admin"] as const)),
  );
  return principal;
}
function id(value: string) {
  if (!isUuid(value)) throw new CableNotFoundError();
  return value;
}
@Controller("v1")
@UseGuards(AuthGuard)
export class CablesController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @Post("cables")
  async create(
    @Req() req: ApiRequest,
    @Res({ passthrough: true }) res: ApiResponse,
    @Body() body: unknown,
  ) {
    authorized(req, true);
    const key = parseIdempotencyKey(header(req, "idempotency-key"));
    const result = await createCable(
      this.db,
      commandContext(req as Required<ApiRequest>, key),
      parseCable(body),
    );
    res.setHeader("ETag", etag(result.cableVersion));
    res.setHeader("Location", `/v1/cables/${result.cableId}`);
    return result;
  }
  @Get("bins/:id/cables")
  async list(
    @Req() req: ApiRequest,
    @Param("id") binId: string,
    @Query("limit") limit?: string,
    @Query("after") after?: string,
  ) {
    const principal = authorized(req);
    const page = parsePage(limit, after);
    const take = Math.min(page.limit, 20);
    const items = await listCables(
      this.db,
      principal.tenantId,
      id(binId),
      take,
      page.afterDeviceId,
    );
    return {
      items,
      nextCursor: items.length === take ? items.at(-1)?.cableId : null,
    };
  }
  @Get("cables/:id")
  async get(
    @Req() req: ApiRequest,
    @Res({ passthrough: true }) res: ApiResponse,
    @Param("id") cableId: string,
  ) {
    const principal = authorized(req);
    const result = await getCable(this.db, principal.tenantId, id(cableId));
    res.setHeader("ETag", etag(result.cableVersion));
    return result;
  }
  @Patch("cables/:id")
  async change(
    @Req() req: ApiRequest,
    @Res({ passthrough: true }) res: ApiResponse,
    @Param("id") cableId: string,
    @Body() body: unknown,
  ) {
    authorized(req, true);
    const expected = parseIfMatch(header(req, "if-match"));
    const result = await changeCable(
      this.db,
      commandContext(req as Required<ApiRequest>, randomUUID()),
      id(cableId),
      expected,
      parseCable(body, true),
    );
    res.setHeader("ETag", etag(result.cableVersion));
    return result;
  }
  @Delete("cables/:id")
  async remove(
    @Req() req: ApiRequest,
    @Res({ passthrough: true }) res: ApiResponse,
    @Param("id") cableId: string,
  ) {
    authorized(req, true);
    const expected = parseIfMatch(header(req, "if-match"));
    const result = await removeCable(
      this.db,
      commandContext(req as Required<ApiRequest>, randomUUID()),
      id(cableId),
      expected,
    );
    res.setHeader("ETag", etag(result.cableVersion));
    return result;
  }
}
