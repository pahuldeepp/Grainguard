import {
  Controller,
  Get,
  Inject,
  Query,
  Req,
  Res,
  UseGuards,
} from "@nestjs/common";
import type { ServerResponse } from "node:http";
import { readRules } from "../alerts/reads.js";
import type { Db } from "../db/client.js";
import { withTenant } from "../db/tenant.js";
import { ALERTS_DB } from "./alerts.controller.js";
import {
  principalWith,
  READERS,
  TenantGuard,
  type AlertRequest,
} from "./auth.js";
import { ruleIds } from "./history.js";

@Controller("v1/alert-rules")
@UseGuards(TenantGuard)
export class AlertRulesController {
  constructor(@Inject(ALERTS_DB) private readonly db: Db) {}
  @Get()
  async get(
    @Req() req: AlertRequest,
    @Res({ passthrough: true }) res: ServerResponse,
    @Query("ids") ids?: string,
  ) {
    const { tenantId } = principalWith(req, READERS);
    const selected = ruleIds(ids);
    res.setHeader("Cache-Control", "private, no-store");
    return {
      items: await withTenant(this.db, tenantId, (tx) =>
        readRules(tx, tenantId, selected),
      ),
    };
  }
}
