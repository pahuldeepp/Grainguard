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
import { InvalidInputError } from "../domain/errors.js";
import type { Actor } from "../domain/store.js";
import { IdentityGuard } from "../api/guards.js";
import { CONTROL_DB } from "../api/controllers.js";
import { commandFrom, type ControlRequest, strictBody } from "../api/http.js";
import {
  getFlags,
  putFlags,
  requireTenantSettable,
  validateFlags,
  type Flags,
} from "./store.js";

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
    const raw = req.headers["if-match"];
    const match =
      typeof raw === "string" ? /^"(0|[1-9]\d{0,18})"$/.exec(raw) : null;
    if (!match)
      throw new InvalidInputError(
        'If-Match must be a quoted version; use "0" to create',
      );
    const input = strictBody<{ flags: Flags }>(body, {
      flags: (v) => !!v && typeof v === "object" && !Array.isArray(v),
    });
    const flags = validateFlags(input.flags);
    requireTenantSettable(flags);
    const result = await putFlags(
      this.db,
      tenantId,
      req.actor as Actor,
      flags,
      BigInt(match[1]!),
      commandFrom(req),
    );
    res.setHeader("ETag", `"${result.version}"`);
    return result;
  }
}
