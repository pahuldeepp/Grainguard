import {
  Body,
  Controller,
  Get,
  Inject,
  Param,
  Put,
  Req,
  Res,
  UseGuards,
} from "@nestjs/common";
import type { ServerResponse } from "node:http";
import type { Db } from "../db/client.js";
import type { Actor } from "../domain/store.js";
import { IdentityGuard } from "../api/guards.js";
import { CONTROL_DB } from "../api/controllers.js";
import { commandFrom, type ControlRequest } from "../api/http.js";
import { getFlags, putFlags, requireTenantSettable } from "./store.js";
import { parseFlagUpdate } from "./controller-input.js";

type Reply = ServerResponse & { status(code: number): unknown };

@Controller("v1/organizations/:tenantId/flags")
@UseGuards(IdentityGuard)
export class FlagsController {
  constructor(@Inject(CONTROL_DB) private readonly db: Db) {}

  @Get()
  async get(
    @Req() req: ControlRequest,
    @Param("tenantId") tenantId: string,
    @Res({ passthrough: true }) res: Reply,
  ) {
    const result = await getFlags(this.db, tenantId, req.actor as Actor);
    res.setHeader("ETag", `"${result.version}"`);
    return result;
  }

  @Put()
  async put(
    @Req() req: ControlRequest,
    @Param("tenantId") tenantId: string,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Reply,
  ) {
    const { flags, expectedVersion } = parseFlagUpdate(
      body,
      req.headers["if-match"],
    );
    requireTenantSettable(flags);
    const result = await putFlags(
      this.db,
      tenantId,
      req.actor as Actor,
      flags,
      expectedVersion,
      commandFrom(req),
    );
    res.setHeader("ETag", `"${result.version}"`);
    return result;
  }
}
