import { createHash, timingSafeEqual } from "node:crypto";
import {
  Body,
  CanActivate,
  Controller,
  ExecutionContext,
  Inject,
  Injectable,
  Put,
  Req,
  Res,
  UseGuards,
} from "@nestjs/common";
import type { ServerResponse } from "node:http";
import { AuthError } from "@greenguard/tenant-auth";
import type { Db } from "../db/client.js";
import { CONTROL_DB } from "../api/controllers.js";
import {
  commandFrom,
  correlationOf,
  type ControlRequest,
} from "../api/http.js";
import { putGlobalFlags, requireRegisteredFlags } from "./store.js";
import { parseFlagUpdate } from "./controller-input.js";

export const FLAG_ADMIN_TOKEN = "CONTROL_FLAG_ADMIN_TOKEN";
export const FLAG_ADMIN_ACTOR_ID = "CONTROL_FLAG_ADMIN_ACTOR_ID";
const digest = (value: string) => createHash("sha256").update(value).digest();

@Injectable()
export class GlobalFlagGuard implements CanActivate {
  private readonly expected: Buffer;
  constructor(@Inject(FLAG_ADMIN_TOKEN) token: string) {
    this.expected = digest(token);
  }
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<ControlRequest>();
    req.correlationId = correlationOf(req);
    const presented = /^Bearer (\S+)$/.exec(
      req.headers.authorization ?? "",
    )?.[1];
    if (!presented || !timingSafeEqual(digest(presented), this.expected))
      throw new AuthError(401, "invalid_token");
    return true;
  }
}

type Reply = ServerResponse & { status(code: number): unknown };

@Controller("v1/internal/flags/global")
@UseGuards(GlobalFlagGuard)
export class GlobalFlagsController {
  constructor(
    @Inject(CONTROL_DB) private readonly db: Db,
    @Inject(FLAG_ADMIN_ACTOR_ID) private readonly actorId: string,
  ) {}
  @Put()
  async put(
    @Req() req: ControlRequest,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Reply,
  ) {
    const { flags, expectedVersion } = parseFlagUpdate(
      body,
      req.headers["if-match"],
    );
    requireRegisteredFlags(flags);
    const result = await putGlobalFlags(
      this.db,
      this.actorId,
      flags,
      expectedVersion,
      commandFrom(req),
    );
    res.setHeader("ETag", `"${result.version}"`);
    return result;
  }
}
