import {
  Controller,
  Get,
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
import { AlertNotFoundError } from "../alerts/errors.js";
import { acknowledge } from "../alerts/lifecycle.js";
import { listEpisodes, readEpisode } from "../alerts/store.js";
import type { Db } from "../db/client.js";
import { isUuid, withTenant } from "../db/tenant.js";
import {
  principalWith,
  READERS,
  RESPONDERS,
  TenantGuard,
  type AlertRequest,
} from "./auth.js";
import {
  correlate,
  etag,
  expectedVersion,
  idempotencyKey,
  page,
  toAlertDto,
} from "./parse.js";

export const ALERTS_DB = "ALERTS_DB";

const alertId = (id: string): string => {
  if (!isUuid(id)) throw new AlertNotFoundError();
  return id;
};

@Controller("v1/alerts")
@UseGuards(TenantGuard)
export class AlertsController {
  constructor(@Inject(ALERTS_DB) private readonly db: Db) {}

  @Get()
  async list(
    @Req() req: AlertRequest,
    @Query("limit") limit?: string,
    @Query("after") after?: string,
    @Query("state") state?: string,
  ) {
    const { tenantId } = principalWith(req, READERS);
    const request = page(limit, after, state);
    const items = await withTenant(this.db, tenantId, (tx) =>
      listEpisodes(tx, tenantId, request),
    );
    return {
      items: items.map(toAlertDto),
      nextCursor:
        items.length === request.limit ? items.at(-1)?.episodeId : null,
    };
  }

  @Get(":id")
  async get(
    @Req() req: AlertRequest,
    @Res({ passthrough: true }) res: ServerResponse,
    @Param("id") id: string,
  ) {
    const { tenantId } = principalWith(req, READERS);
    const episode = await withTenant(this.db, tenantId, (tx) =>
      readEpisode(tx, tenantId, alertId(id)),
    );
    if (!episode) throw new AlertNotFoundError();
    res.setHeader("ETag", etag(episode.version));
    return toAlertDto(episode);
  }

  @Post(":id/acknowledge")
  @HttpCode(200)
  async acknowledge(
    @Req() req: AlertRequest,
    @Res({ passthrough: true }) res: ServerResponse,
    @Param("id") id: string,
  ) {
    const principal = principalWith(req, RESPONDERS);
    const key = idempotencyKey(req);
    const version = expectedVersion(req);
    correlate(req);
    const result = await acknowledge(
      this.db,
      {
        tenantId: principal.tenantId,
        actorId: principal.subject,
        correlationId: req.correlationId as string,
        traceparent: req.traceparent as string,
        idempotencyKey: key,
      },
      alertId(id),
      version,
    );
    res.setHeader("ETag", etag(result.version));
    return result;
  }
}
