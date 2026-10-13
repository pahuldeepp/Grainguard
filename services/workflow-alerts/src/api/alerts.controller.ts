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
import { readTransitions, lifecycleComplete } from "../alerts/reads.js";
import { HISTORY_CURSOR, HistoryCursor, historyPage } from "./history.js";
import { IDENTITY, IdentityDisplay } from "./identity.js";
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
const CAUSE_KINDS = {
  opened: "risk_event",
  updated: "risk_event",
  resolved: "risk_event",
  acknowledged: "command",
  escalated: "escalation_check",
  escalation_suppressed: "escalation_check",
} as const;

const alertId = (id: string): string => {
  if (!isUuid(id)) throw new AlertNotFoundError();
  return id;
};

@Controller("v1/alerts")
@UseGuards(TenantGuard)
export class AlertsController {
  constructor(
    @Inject(ALERTS_DB) private readonly db: Db,
    @Inject(IDENTITY) private readonly identity: IdentityDisplay,
    @Inject(HISTORY_CURSOR) private readonly cursor: HistoryCursor,
  ) {}

  @Get()
  async list(
    @Req() req: AlertRequest,
    @Query("limit") limit?: string,
    @Query("after") after?: string,
    @Query("state") state?: string,
    @Query("deviceId") deviceId?: string,
  ) {
    const principal = principalWith(req, READERS);
    const { tenantId } = principal;
    const request = page(limit, after, state, deviceId);
    const items = await withTenant(this.db, tenantId, (tx) =>
      listEpisodes(tx, tenantId, request),
    );
    return {
      ...(deviceId ? { association: "current_assessment_source_device" } : {}),
      items: items.map((e) =>
        toAlertDto(
          e,
          this.identity.actor(
            principal,
            e.acknowledgedBy ? "user" : "system",
            e.acknowledgedBy,
            e.acknowledgedByIssuer,
          ),
        ),
      ),
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
    const principal = principalWith(req, READERS);
    const { tenantId } = principal;
    const episode = await withTenant(this.db, tenantId, (tx) =>
      readEpisode(tx, tenantId, alertId(id)),
    );
    if (!episode) throw new AlertNotFoundError();
    res.setHeader("ETag", etag(episode.version));
    return toAlertDto(
      episode,
      this.identity.actor(
        principal,
        episode.acknowledgedBy ? "user" : "system",
        episode.acknowledgedBy,
        episode.acknowledgedByIssuer,
      ),
    );
  }

  @Get(":id/transitions")
  async transitions(
    @Req() req: AlertRequest,
    @Param("id") id: string,
    @Query("limit") limit?: string,
    @Query("after") after?: string,
    @Query("include") include?: string,
  ) {
    const principal = principalWith(req, READERS);
    const { tenantId } = principal;
    const selected = historyPage(limit, include);
    if (selected.include === "all") principalWith(req, ["admin"]);
    const episodeId = alertId(id);
    const position =
      after === undefined
        ? undefined
        : this.cursor.decode(after, tenantId, episodeId, selected.include);
    return withTenant(
      this.db,
      tenantId,
      async (tx) => {
        // Episode, coverage and page share one repeatable-read snapshot.
        const episode = await readEpisode(tx, tenantId, episodeId);
        if (!episode) throw new AlertNotFoundError();
        const rows = await readTransitions(
          tx,
          tenantId,
          episodeId,
          selected.limit,
          selected.include,
          position,
        );
        const complete = await lifecycleComplete(
          tx,
          tenantId,
          episodeId,
          episode.version,
        );
        const items = rows.slice(0, selected.limit);
        const last = items.at(-1);
        return {
          alertId: episodeId,
          items: items.map((row) => ({
            transitionId: row.transition_id,
            version: row.episode_version.toString(),
            type: row.transition_type,
            fromState: row.from_state,
            toState: row.to_state,
            occurredAt: row.occurred_at_text,
            actor: this.identity.actor(
              principal,
              row.actor_type,
              row.actor_id,
              row.actor_issuer,
            ),
            cause: { kind: CAUSE_KINDS[row.transition_type] },
          })),
          nextCursor:
            rows.length > selected.limit && last
              ? this.cursor.encode(tenantId, episodeId, selected.include, {
                  version: last.episode_version.toString(),
                  occurredAt: last.occurred_at_text,
                  transitionId: last.transition_id,
                })
              : null,
          complete,
          source: {
            status: complete ? (items.length ? "ok" : "empty") : "partial",
            reasonCode: complete ? null : "incomplete_lifecycle",
          },
        };
      },
      2000,
      "RepeatableRead",
    );
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
        actorIssuer: principal.issuer,
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
