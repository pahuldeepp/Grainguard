import {
  Body,
  Controller,
  Get,
  Headers,
  Inject,
  Param,
  Put,
  Req,
  Res,
  UseGuards,
} from "@nestjs/common";
import type { ServerResponse } from "node:http";
import type { Db } from "../db/client.js";
import { CONTROL_DB } from "../api/controllers.js";
import { IdentityGuard, LookupGuard } from "../api/guards.js";
import type { ControlRequest } from "../api/http.js";
import type { Actor } from "../domain/store.js";
import { InvalidInputError } from "../domain/errors.js";
import {
  getNotificationContacts,
  putNotificationContacts,
  validateContacts,
} from "./contacts.js";

type Reply = ServerResponse & { status(code: number): unknown };

@Controller("v1/organizations/:tenantId/notification-contacts")
@UseGuards(IdentityGuard)
export class NotificationContactsController {
  constructor(@Inject(CONTROL_DB) private readonly db: Db) {}

  @Put()
  async put(
    @Req() req: ControlRequest,
    @Param("tenantId") tenantId: string,
    @Body() body: unknown,
    @Headers("if-match") ifMatch: string | undefined,
    @Res({ passthrough: true }) res: Reply,
  ) {
    const version =
      typeof ifMatch === "string"
        ? /^"(0|[1-9]\d{0,18})"$/.exec(ifMatch)
        : null;
    if (!version)
      throw new InvalidInputError(
        'If-Match must be a quoted version; use "0" to create',
      );
    const result = await putNotificationContacts(
      this.db,
      tenantId,
      req.actor as Actor,
      validateContacts(body),
      BigInt(version[1]!),
    );
    res.setHeader("ETag", `"${result.version}"`);
    return result;
  }
}

@Controller("v1/internal/notification-contacts")
@UseGuards(LookupGuard)
export class InternalNotificationContactsController {
  constructor(@Inject(CONTROL_DB) private readonly db: Db) {}

  @Get(":tenantId")
  get(@Param("tenantId") tenantId: string) {
    return getNotificationContacts(this.db, tenantId);
  }
}
