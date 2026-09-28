import { Controller, Get, Inject, Param, UseGuards } from "@nestjs/common";
import type { Db } from "../db/client.js";
import { CONTROL_DB } from "../api/controllers.js";
import { LookupGuard } from "../api/guards.js";
import { getFlagSnapshot } from "./store.js";

@Controller("v1/internal/flags")
@UseGuards(LookupGuard)
export class FlagSnapshotsController {
  constructor(@Inject(CONTROL_DB) private readonly db: Db) {}
  @Get(":tenantId")
  snapshot(@Param("tenantId") tenantId: string) {
    return getFlagSnapshot(this.db, tenantId);
  }
}
